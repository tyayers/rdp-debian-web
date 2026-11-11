#![allow(unused_crate_dependencies)]

use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use ironrdp_cliprdr::backend::CliprdrBackend;
use ironrdp_cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
    OwnedFormatDataResponse,
};
use ironrdp_cliprdr::CliprdrClient;
use ironrdp_connector::connection_activation::{
    ConnectionActivationFactory, ConnectionActivationSequence, ConnectionActivationState,
};
use ironrdp_connector::{
    ClientConnector, ClientConnectorState, Config, Credentials, DesktopSize, Sequence as _,
};
use ironrdp_core::{IntoOwned as _, WriteBuf};
use ironrdp_displaycontrol::client::DisplayControlClient;
use ironrdp_displaycontrol::pdu::{
    DisplayControlMonitorLayout, DisplayControlPdu, MonitorLayoutEntry, MonitorOrientation,
};
use ironrdp_dvc::{DrdynvcClient, encode_dvc_messages};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_input::{
    Database as InputDatabase, MouseButton, MousePosition, Operation, Scancode, WheelRotations,
};
use ironrdp_pdu::gcc::KeyboardType;
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_pdu::mcs;
use ironrdp_pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp_pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp_pdu::rdp::headers::{
    BASIC_SECURITY_HEADER_SIZE, BasicSecurityHeaderFlags, ShareDataPdu, decode_share_data,
};
use ironrdp_pdu::rdp::server_error_info::{ErrorInfo, ProtocolIndependentCode, ServerSetErrorInfoPdu};
use ironrdp_pdu::x224::X224;
use ironrdp_pdu::{Action, find_size};
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput, fast_path};
use ironrdp_svc::ChannelFlags;
use js_sys::{Date, Function, Uint8Array};
use wasm_bindgen::prelude::*;

#[derive(Debug)]
enum ClipAction {
    SendInitialFormatList,
    RequestPasteFormat(ClipboardFormatId),
    SendFormatData(OwnedFormatDataResponse),
    RemoteTextReady(String),
}

#[derive(Debug, Default)]
struct SharedClipState {
    local_text: String,
    actions: VecDeque<ClipAction>,
}

#[derive(Debug, Default)]
struct DisplayControlState {
    ready: bool,
    max_monitor_area: Option<u64>,
    just_became_ready: bool,
}

#[derive(Debug)]
struct WasmClipBackend {
    shared: Arc<Mutex<SharedClipState>>,
}

impl ironrdp_core::AsAny for WasmClipBackend {
    fn as_any(&self) -> &dyn core::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn core::any::Any {
        self
    }
}

impl CliprdrBackend for WasmClipBackend {
    fn temporary_directory(&self) -> &str {
        ".cliprdr"
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::empty()
    }

    fn on_ready(&mut self) {}

    fn on_request_format_list(&mut self) {
        if let Ok(mut guard) = self.shared.lock() {
            guard.actions.push_back(ClipAction::SendInitialFormatList);
        }
    }

    fn on_process_negotiated_capabilities(&mut self, _capabilities: ClipboardGeneralCapabilityFlags) {}

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        let preferred = available_formats
            .iter()
            .find(|f| f.id() == ClipboardFormatId::CF_UNICODETEXT)
            .or_else(|| {
                available_formats
                    .iter()
                    .find(|f| f.id() == ClipboardFormatId::CF_TEXT)
            });

        if let Some(fmt) = preferred
            && let Ok(mut guard) = self.shared.lock()
        {
            guard.actions.push_back(ClipAction::RequestPasteFormat(fmt.id()));
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        if let Ok(mut guard) = self.shared.lock() {
            let response = if request.format == ClipboardFormatId::CF_UNICODETEXT {
                let crlf = guard.local_text.replace("\r\n", "\n").replace('\n', "\r\n");
                FormatDataResponse::new_unicode_string(&crlf).into_owned()
            } else if request.format == ClipboardFormatId::CF_TEXT {
                let mut bytes = guard
                    .local_text
                    .replace("\r\n", "\n")
                    .replace('\n', "\r\n")
                    .into_bytes();
                bytes.push(0);
                FormatDataResponse::new_data(bytes).into_owned()
            } else {
                FormatDataResponse::new_error().into_owned()
            };
            guard.actions.push_back(ClipAction::SendFormatData(response));
        }
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            return;
        }
        let data = response.data();
        if data.is_empty() {
            return;
        }
        let text = if data.len() >= 2 && data.len() % 2 == 0 {
            let units: Vec<u16> = data
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|&u| u != 0)
                .collect();
            String::from_utf16_lossy(&units)
        } else {
            let trimmed = data.split(|&b| b == 0).next().unwrap_or(data);
            String::from_utf8_lossy(trimmed).into_owned()
        };
        let normalized = text.replace("\r\n", "\n");
        if !normalized.is_empty()
            && let Ok(mut guard) = self.shared.lock()
        {
            guard.actions.push_back(ClipAction::RemoteTextReady(normalized));
        }
    }

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {}
    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}
    fn on_lock(&mut self, _data_id: LockDataId) {}
    fn on_unlock(&mut self, _data_id: LockDataId) {}

    fn now_ms(&self) -> u64 {
        let ms = Date::now();
        if ms.is_finite() && ms >= 0.0 {
            ms as u64
        } else {
            0
        }
    }
}

enum Stage {
    Connecting(Box<ClientConnector>),
    Active {
        stage: Box<ActiveStage>,
        activation_factory: ConnectionActivationFactory,
        io_channel_id: u16,
    },
    Reactivating {
        seq: Box<ConnectionActivationSequence>,
        stage: Box<ActiveStage>,
        activation_factory: ConnectionActivationFactory,
        io_channel_id: u16,
    },
    Terminated,
}

#[derive(Debug)]
enum X224FrameKind {
    /// MCS DisconnectProviderUltimatum from server
    Disconnect(mcs::DisconnectReason),
    /// Non-IO static virtual channel or message channel (e.g. drdynvc, cliprdr, autodetect)
    NonIoChannel,
    /// Server Deactivate All PDU (including XRDP's compact 6-byte header-only variant!)
    DeactivateAll,
    /// Server Demand Active PDU
    DemandActive,
    /// Finalization ShareDataPdu (Synchronize, Control, FontMap)
    FinalizationData,
    /// ServerSetErrorInfo(None)
    ErrorInfoNone,
    /// ServerSetErrorInfo(non-None error)
    FatalErrorInfo(String),
    /// Normal active-session ShareDataPdu (Update, Pointer, SaveSessionInfo, SetKeyboardIndicators, ShutdownDenied)
    ActiveSessionData,
    /// Multitransport request on IO channel
    IoMultitransport,
    /// Unrecognized or benign ShareDataPdu (e.g. PlaySound)
    OtherShareData,
    /// Other X.224 / MCS handshake frame (during initial connection before CapabilitiesExchange)
    OtherHandshake,
}

struct HostCallbacks {
    on_send: Function,
    on_connected: Function,
    on_resize: Function,
    on_draw_rect: Function,
    on_cursor: Function,
    on_clipboard: Function,
    on_terminated: Function,
    on_log: Function,
}

#[wasm_bindgen]
pub struct RdpSession {
    stage: Stage,
    image: DecodedImage,
    input_db: InputDatabase,
    rx_buf: Vec<u8>,
    deferred_frames: VecDeque<(Action, Vec<u8>)>,
    blit_buf: Vec<u8>,
    clip_state: Arc<Mutex<SharedClipState>>,
    disp_state: Arc<Mutex<DisplayControlState>>,
    pending_resize: Option<(u32, u32)>,
    last_requested_resize: Option<(u32, u32)>,
    rendered_frames: u64,
    cb: HostCallbacks,
}

#[wasm_bindgen]
impl RdpSession {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        width: u16,
        height: u16,
        username: &str,
        password: &str,
        domain: &str,
        on_send: Function,
        on_connected: Function,
        on_resize: Function,
        on_draw_rect: Function,
        on_cursor: Function,
        on_clipboard: Function,
        on_terminated: Function,
        on_log: Function,
    ) -> Self {
        let safe_w = width.clamp(320, 4096) & !1;
        let safe_h = height.clamp(240, 4096);

        let config = Config {
            credentials: Credentials::UsernamePassword {
                username: username.to_owned(),
                password: password.to_owned(),
            },
            domain: if domain.is_empty() {
                None
            } else {
                Some(domain.to_owned())
            },
            enable_tls: true,
            enable_credssp: false, // Linux xrdp uses TLS + PAM autologon via ClientInfoPdu
            keyboard_type: KeyboardType::IbmEnhanced,
            keyboard_subtype: 0,
            keyboard_functional_keys_count: 12,
            keyboard_layout: 0, // Must be 0 when ClientInfoPdu code_page is 0
            ime_file_name: String::new(),
            dig_product_id: String::new(),
            desktop_size: DesktopSize {
                width: safe_w,
                height: safe_h,
            },
            desktop_scale_factor: 0,
            bitmap: None, // Uses default RemoteFX + uncompressed/RLE/RDP6 codec capabilities
            client_build: 0,
            client_name: "apigee-web".to_owned(),
            client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
            platform: MajorPlatformType::UNIX,
            hardware_id: None,
            request_data: None,
            autologon: true,
            enable_audio_playback: false,
            performance_flags: PerformanceFlags::default(),
            license_cache: None,
            timezone_info: TimezoneInfo::default(),
            compression_type: None, // Avoid MPPC/XCRUSH bulk compression issues with xrdp on localhost
            enable_server_pointer: true,
            pointer_software_rendering: false,
            multitransport_flags: None,
            alternate_shell: String::new(),
            work_dir: String::new(),
        };

        let clip_state = Arc::new(Mutex::new(SharedClipState::default()));
        let disp_state = Arc::new(Mutex::new(DisplayControlState::default()));

        let clip_backend = Box::new(WasmClipBackend {
            shared: Arc::clone(&clip_state),
        });
        let cliprdr = CliprdrClient::new(clip_backend);

        let disp_state_cb = Arc::clone(&disp_state);
        let dvc = DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(move |caps| {
            if let Ok(mut guard) = disp_state_cb.lock() {
                guard.ready = true;
                guard.max_monitor_area = Some(caps.max_monitor_area());
                guard.just_became_ready = true;
            }
            Ok(Vec::new())
        }));

        let client_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 49152);
        let connector = ClientConnector::new(config, client_addr)
            .with_static_channel(cliprdr)
            .with_static_channel(dvc);

        let image = DecodedImage::new(PixelFormat::RgbA32, safe_w, safe_h);

        Self {
            stage: Stage::Connecting(Box::new(connector)),
            image,
            input_db: InputDatabase::new(),
            rx_buf: Vec::with_capacity(65536),
            deferred_frames: VecDeque::new(),
            blit_buf: Vec::with_capacity(65536),
            clip_state,
            disp_state,
            pending_resize: None,
            last_requested_resize: None,
            rendered_frames: 0,
            cb: HostCallbacks {
                on_send,
                on_connected,
                on_resize,
                on_draw_rect,
                on_cursor,
                on_clipboard,
                on_terminated,
                on_log,
            },
        }
    }

    pub fn start(&mut self) -> Result<(), JsValue> {
        let mut out = WriteBuf::new();
        let written = {
            let Stage::Connecting(connector) = &mut self.stage else {
                return Err(JsValue::from_str("session already started"));
            };
            connector
                .step_no_input(&mut out)
                .map_err(|e| JsValue::from_str(&format!("RDP initiation failed: {e}")))?
        };
        if written.size().is_some() {
            self.emit_log(&format!(
                "Sent X.224 Connection Request ({} bytes)",
                out.filled_len()
            ));
            self.emit_send(1, out.filled());
        }
        Ok(())
    }

    pub fn on_tls_ready(&mut self, x224_confirm: &[u8]) -> Result<(), JsValue> {
        let mut out = WriteBuf::new();
        let next_state_name = {
            let Stage::Connecting(connector) = &mut self.stage else {
                return Err(JsValue::from_str("unexpected TLS upgrade response"));
            };
            connector
                .step(x224_confirm, &mut out)
                .map_err(|e| JsValue::from_str(&format!("RDP negotiation rejected: {e}")))?;
            if connector.should_perform_security_upgrade() {
                connector.mark_security_upgrade_as_done();
            }
            connector.state().name()
        };
        self.emit_log(&format!(
            "TLS upgrade acknowledged; advancing connector -> {next_state_name}"
        ));
        if out.filled_len() > 0 {
            self.emit_send(0, out.filled());
        }

        self.drive_no_input_steps().map_err(|e| JsValue::from_str(&e))
    }

    pub fn on_rdp_data(&mut self, chunk: &[u8]) -> Result<(), JsValue> {
        self.on_rdp_data_inner(chunk).map_err(|e| {
            self.emit_log(&format!("ERROR in on_rdp_data: {e}"));
            JsValue::from_str(&e)
        })
    }

    pub fn mouse_move(&mut self, x: u16, y: u16) {
        self.apply_input([Operation::MouseMove(MousePosition { x, y })]);
    }

    pub fn mouse_button(&mut self, web_button: u8, pressed: bool) {
        let Some(btn) = MouseButton::from_web_button(web_button) else {
            return;
        };
        let op = if pressed {
            Operation::MouseButtonPressed(btn)
        } else {
            Operation::MouseButtonReleased(btn)
        };
        self.apply_input([op]);
    }

    pub fn mouse_wheel(&mut self, rotation_units: i16, is_vertical: bool) {
        self.apply_input([Operation::WheelRotations(WheelRotations {
            is_vertical,
            rotation_units,
        })]);
    }

    pub fn key_scancode(&mut self, scancode: u16, pressed: bool) {
        let code = Scancode::from_u16(scancode);
        let op = if pressed {
            Operation::KeyPressed(code)
        } else {
            Operation::KeyReleased(code)
        };
        self.apply_input([op]);
    }

    pub fn key_unicode(&mut self, codepoint: u32, pressed: bool) {
        let Some(ch) = char::from_u32(codepoint) else {
            return;
        };
        let op = if pressed {
            Operation::UnicodeKeyPressed(ch)
        } else {
            Operation::UnicodeKeyReleased(ch)
        };
        self.apply_input([op]);
    }

    pub fn release_all(&mut self) {
        let outputs = {
            let Stage::Active { stage, .. } = &mut self.stage else {
                return;
            };
            let events = self.input_db.release_all();
            if events.is_empty() {
                return;
            }
            stage.process_fastpath_input(&mut self.image, &events).ok()
        };
        if let Some(outputs) = outputs {
            let _ = self.handle_stage_outputs(outputs);
        }
    }

    pub fn sync_locks(&mut self, scroll: bool, num: bool, caps: bool) {
        let outputs = {
            let Stage::Active { stage, .. } = &mut self.stage else {
                return;
            };
            let ev = ironrdp_input::synchronize_event(scroll, num, caps, false);
            stage.process_fastpath_input(&mut self.image, &[ev]).ok()
        };
        if let Some(outputs) = outputs {
            let _ = self.handle_stage_outputs(outputs);
        }
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        let (adj_w, adj_h) = self.normalize_resize_dims(width, height);
        self.pending_resize = Some((adj_w, adj_h));
        self.flush_pending_resize();
    }

    pub fn copy_text(&mut self, text: &str) {
        if let Ok(mut guard) = self.clip_state.lock() {
            guard.local_text = text.to_owned();
        }
        let mut to_send: Option<Vec<u8>> = None;
        if let Stage::Active { stage, .. } = &mut self.stage {
            let formats = [ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)];
            if let Some(cliprdr) = stage.get_svc_processor_mut::<CliprdrClient>()
                && let Ok(msgs) = cliprdr.initiate_copy(&formats)
                && let Ok(frame) = stage.process_svc_processor_messages(msgs)
            {
                to_send = Some(frame);
            }
        }
        if let Some(frame) = to_send {
            self.emit_send(0, &frame);
        }
    }
}

impl RdpSession {
    fn emit_send(&self, kind: u8, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let arr = Uint8Array::from(bytes);
        let _ = self.cb.on_send.call2(&JsValue::NULL, &JsValue::from(kind), &arr);
    }

    fn emit_log(&self, msg: &str) {
        let _ = self.cb.on_log.call1(&JsValue::NULL, &JsValue::from_str(msg));
    }

    fn emit_terminate(&mut self, reason: &str) {
        self.emit_log(&format!(
            "Session terminated by server (rendered_frames={}): {reason}",
            self.rendered_frames
        ));
        self.stage = Stage::Terminated;
        let _ = self
            .cb
            .on_terminated
            .call1(&JsValue::NULL, &JsValue::from_str(reason));
    }

    fn normalize_resize_dims(&self, width: u32, height: u32) -> (u32, u32) {
        let clamped_w = width.clamp(320, 4096);
        let clamped_h = height.clamp(240, 4096);
        let (mut adj_w, mut adj_h) = MonitorLayoutEntry::adjust_display_size(clamped_w, clamped_h);

        let max_area = self
            .disp_state
            .lock()
            .ok()
            .and_then(|g| g.max_monitor_area)
            .unwrap_or(0);

        if max_area > 0 {
            let area = u64::from(adj_w) * u64::from(adj_h);
            if area > max_area {
                let scale = (max_area as f64 / area as f64).sqrt();
                let scaled_w = ((adj_w as f64) * scale).floor() as u32;
                let scaled_h = ((adj_h as f64) * scale).floor() as u32;
                (adj_w, adj_h) = MonitorLayoutEntry::adjust_display_size(
                    scaled_w.max(320),
                    scaled_h.max(240),
                );
            }
        }

        (adj_w, adj_h)
    }

    fn flush_pending_resize(&mut self) {
        let mut became_ready_msg: Option<u64> = None;
        let is_ready = if let Ok(mut guard) = self.disp_state.lock() {
            if guard.just_became_ready {
                guard.just_became_ready = false;
                became_ready_msg = guard.max_monitor_area;
            }
            guard.ready
        } else {
            false
        };

        if let Some(max_area) = became_ready_msg {
            self.emit_log(&format!(
                "DisplayControl dynamic channel ready (max_monitor_area={max_area})"
            ));
        }

        let Some((req_w, req_h)) = self.pending_resize else {
            return;
        };

        let (adj_w, adj_h) = self.normalize_resize_dims(req_w, req_h);

        // Wait until ActiveStage is active and DisplayControl has received server capabilities
        if !is_ready {
            self.pending_resize = Some((adj_w, adj_h));
            return;
        }

        let encode_result: Option<Result<Vec<u8>, String>> = {
            let Stage::Active { stage, .. } = &mut self.stage else {
                // Keep pending_resize queued until Connecting / Reactivating finishes
                self.pending_resize = Some((adj_w, adj_h));
                return;
            };

            if adj_w == u32::from(self.image.width()) && adj_h == u32::from(self.image.height()) {
                self.pending_resize = None;
                self.last_requested_resize = None;
                return;
            }

            if self.last_requested_resize == Some((adj_w, adj_h)) {
                self.pending_resize = None;
                return;
            }

            let channel_id_opt = stage
                .get_dvc::<DisplayControlClient>()
                .and_then(|dvc| {
                    let dc = dvc.channel_processor_downcast_ref::<DisplayControlClient>()?;
                    if dc.ready() { dvc.channel_id() } else { None }
                });

            let Some(channel_id) = channel_id_opt else {
                self.pending_resize = Some((adj_w, adj_h));
                return;
            };

            // Always use MonitorOrientation::Landscape (0°) so narrow/split browser windows
            // (where width <= height) never trigger a 90° sideways rotation in xorgxrdp!
            let res = (|| -> Result<Vec<u8>, String> {
                let entry = MonitorLayoutEntry::new_primary(adj_w, adj_h)
                    .map_err(|e| format!("MonitorLayoutEntry error: {e}"))?
                    .with_orientation(MonitorOrientation::Landscape);
                let layout = DisplayControlMonitorLayout::new(&[entry])
                    .map_err(|e| format!("DisplayControlMonitorLayout error: {e}"))?;
                let pdu = DisplayControlPdu::MonitorLayout(layout);
                let svc_messages =
                    encode_dvc_messages(channel_id, vec![Box::new(pdu)], ChannelFlags::empty())
                        .map_err(|e| format!("encode_dvc_messages error: {e}"))?;
                stage
                    .encode_dvc_messages(svc_messages)
                    .map_err(|e| format!("stage.encode_dvc_messages error: {e}"))
            })();

            Some(res)
        };

        if let Some(result) = encode_result {
            self.pending_resize = None;
            match result {
                Ok(frame) => {
                    self.last_requested_resize = Some((adj_w, adj_h));
                    self.emit_log(&format!(
                        "Requested DisplayControl resize to {adj_w}x{adj_h}"
                    ));
                    self.emit_send(0, &frame);
                }
                Err(err) => {
                    self.emit_log(&format!("DisplayControl resize encode failed: {err}"));
                }
            }
        }
    }

    fn start_reactivation(&mut self) -> Result<(), String> {
        self.emit_log("Received Server DeactivateAll PDU; starting reactivation");
        self.last_requested_resize = None;
        // Release any pressed keys/buttons cleanly across mode switch
        let _ = self.input_db.release_all();

        let Stage::Active {
            stage,
            activation_factory,
            io_channel_id,
        } = core::mem::replace(&mut self.stage, Stage::Terminated)
        else {
            return Ok(());
        };
        let seq = activation_factory.create();
        self.stage = Stage::Reactivating {
            seq: Box::new(seq),
            stage,
            activation_factory,
            io_channel_id,
        };
        self.drive_no_input_steps()
    }

    fn drive_no_input_steps(&mut self) -> Result<(), String> {
        loop {
            let mut outbound: Option<Vec<u8>> = None;
            let mut log_line: Option<String> = None;
            match &mut self.stage {
                Stage::Connecting(connector) => {
                    if connector.state().is_terminal()
                        || connector.should_perform_security_upgrade()
                        || connector.should_perform_credssp()
                        || connector.next_pdu_hint().is_some()
                    {
                        break;
                    }
                    let prev_state = connector.state().name();
                    let mut out = WriteBuf::new();
                    let written = connector
                        .step_no_input(&mut out)
                        .map_err(|e| format!("RDP handshake error ({prev_state}): {e}"))?;
                    let next_state = connector.state().name();
                    if prev_state != next_state {
                        log_line = Some(format!("Connector step: {prev_state} -> {next_state}"));
                    }
                    if written.size().is_some() {
                        outbound = Some(out.filled().to_vec());
                    }
                }
                Stage::Reactivating { seq, .. } => {
                    if seq.state().is_terminal() || seq.next_pdu_hint().is_some() {
                        break;
                    }
                    let prev_state = seq.state().name();
                    let mut out = WriteBuf::new();
                    let written = seq
                        .step_no_input(&mut out)
                        .map_err(|e| format!("RDP reactivation error ({prev_state}): {e}"))?;
                    let next_state = seq.state().name();
                    if prev_state != next_state {
                        log_line = Some(format!("Reactivation step: {prev_state} -> {next_state}"));
                    }
                    if written.size().is_some() {
                        outbound = Some(out.filled().to_vec());
                    }
                }
                Stage::Active { .. } | Stage::Terminated => break,
            }
            if let Some(line) = log_line {
                self.emit_log(&line);
            }
            if let Some(bytes) = outbound {
                self.emit_send(0, &bytes);
            }
        }

        self.check_transitions()
    }

    fn check_transitions(&mut self) -> Result<(), String> {
        let needs_activate = matches!(
            &self.stage,
            Stage::Connecting(c) if matches!(c.state, ClientConnectorState::Connected { .. })
        );

        if needs_activate {
            let Stage::Connecting(mut connector) =
                core::mem::replace(&mut self.stage, Stage::Terminated)
            else {
                unreachable!()
            };
            let ClientConnectorState::Connected { result } =
                core::mem::replace(&mut connector.state, ClientConnectorState::Consumed)
            else {
                unreachable!()
            };

            let width = result.desktop_size.width;
            let height = result.desktop_size.height;
            self.image = DecodedImage::new(PixelFormat::RgbA32, width, height);

            let io_channel_id = result.io_channel_id;
            let share_id = result.share_id;
            let activation_factory = result.activation_factory;
            let active_stage = ActiveStageBuilder {
                static_channels: result.static_channels,
                user_channel_id: result.user_channel_id,
                io_channel_id: result.io_channel_id,
                message_channel_id: result.message_channel_id,
                share_id: result.share_id,
                compression_type: result.compression_type,
                enable_server_pointer: result.enable_server_pointer,
                pointer_software_rendering: result.pointer_software_rendering,
            }
            .build();

            self.stage = Stage::Active {
                stage: Box::new(active_stage),
                activation_factory,
                io_channel_id,
            };

            self.emit_log(&format!(
                "Entered ActiveStage ({width}x{height}, io_channel={io_channel_id}, share_id={share_id})"
            ));

            let _ = self.cb.on_connected.call2(
                &JsValue::NULL,
                &JsValue::from(u32::from(width)),
                &JsValue::from(u32::from(height)),
            );

            self.drain_deferred_frames()?;
            self.flush_pending_resize();
        }

        let needs_finish_reactivation = matches!(
            &self.stage,
            Stage::Reactivating { seq, .. } if seq.state().is_terminal()
        );

        if needs_finish_reactivation {
            let Stage::Reactivating {
                seq,
                mut stage,
                activation_factory,
                io_channel_id,
            } = core::mem::replace(&mut self.stage, Stage::Terminated)
            else {
                unreachable!()
            };

            if let ConnectionActivationState::Finalized {
                desktop_size,
                share_id,
                enable_server_pointer,
                pointer_software_rendering,
            } = seq.connection_activation_state()
            {
                // Rebuild fast_path::Processor with the updated share_id & fresh codec state,
                // matching Devolutions' official ironrdp-client implementation!
                stage.set_fastpath_processor(
                    fast_path::ProcessorBuilder {
                        io_channel_id: seq.io_channel_id(),
                        user_channel_id: seq.user_channel_id(),
                        share_id,
                        enable_server_pointer,
                        pointer_software_rendering,
                        bulk_decompressor: None,
                    }
                    .build(),
                );
                stage.set_share_id(share_id);
                stage.set_enable_server_pointer(enable_server_pointer);

                self.emit_log(&format!(
                    "Completed Deactivate-Reactivate sequence ({}x{}, share_id={share_id})",
                    desktop_size.width, desktop_size.height
                ));

                self.image = DecodedImage::new(
                    PixelFormat::RgbA32,
                    desktop_size.width,
                    desktop_size.height,
                );
                let _ = self.cb.on_resize.call2(
                    &JsValue::NULL,
                    &JsValue::from(u32::from(desktop_size.width)),
                    &JsValue::from(u32::from(desktop_size.height)),
                );
            }

            self.stage = Stage::Active {
                stage,
                activation_factory,
                io_channel_id,
            };

            self.drain_deferred_frames()?;
            self.flush_pending_resize();
        }

        Ok(())
    }

    fn drain_deferred_frames(&mut self) -> Result<(), String> {
        while matches!(self.stage, Stage::Active { .. }) {
            let Some((action, frame)) = self.deferred_frames.pop_front() else {
                break;
            };
            self.process_active_frame(action, &frame)?;
        }
        Ok(())
    }

    fn on_rdp_data_inner(&mut self, chunk: &[u8]) -> Result<(), String> {
        if matches!(self.stage, Stage::Terminated) || chunk.is_empty() {
            return Ok(());
        }
        self.rx_buf.extend_from_slice(chunk);

        loop {
            if matches!(self.stage, Stage::Terminated) {
                break;
            }

            self.drive_no_input_steps()?;

            let Some(pdu_info) =
                find_size(&self.rx_buf).map_err(|e| format!("PDU header decode error: {e}"))?
            else {
                break;
            };

            if self.rx_buf.len() < pdu_info.length {
                break;
            }

            let frame: Vec<u8> = self.rx_buf.drain(..pdu_info.length).collect();

            let mut outbound: Option<Vec<u8>> = None;
            let mut log_line: Option<String> = None;
            match &mut self.stage {
                Stage::Connecting(connector) => {
                    if pdu_info.action == Action::FastPath {
                        self.deferred_frames.push_back((Action::FastPath, frame));
                        continue;
                    }
                    if let ClientConnectorState::ConnectionFinalization { connection_activation } =
                        &connector.state
                    {
                        let expected_io = connection_activation.io_channel_id();
                        let kind = classify_x224_frame(&frame, expected_io);
                        match kind {
                            X224FrameKind::Disconnect(reason) => {
                                let msg = reason.description().to_owned();
                                self.emit_terminate(&msg);
                                break;
                            }
                            X224FrameKind::FatalErrorInfo(desc) => {
                                self.emit_terminate(&desc);
                                break;
                            }
                            X224FrameKind::NonIoChannel => {
                                self.deferred_frames.push_back((Action::X224, frame));
                                continue;
                            }
                            X224FrameKind::DeactivateAll => {
                                // Ignore compact 6-byte or full DeactivateAll during initial activation
                                continue;
                            }
                            X224FrameKind::ActiveSessionData => {
                                if matches!(
                                    connection_activation.connection_activation_state(),
                                    ConnectionActivationState::ConnectionFinalization { .. }
                                ) {
                                    self.deferred_frames.push_back((Action::X224, frame));
                                }
                                continue;
                            }
                            X224FrameKind::OtherShareData | X224FrameKind::IoMultitransport => {
                                continue;
                            }
                            X224FrameKind::DemandActive
                            | X224FrameKind::FinalizationData
                            | X224FrameKind::ErrorInfoNone
                            | X224FrameKind::OtherHandshake => {}
                        }
                    }

                    let prev_state = connector.state().name();
                    let mut out = WriteBuf::new();
                    let written = connector
                        .step(&frame, &mut out)
                        .map_err(|e| format!("RDP connection failed ({prev_state}): {e}"))?;
                    let next_state = connector.state().name();
                    if prev_state != next_state {
                        log_line = Some(format!("Connector PDU: {prev_state} -> {next_state}"));
                    }
                    if written.size().is_some() {
                        outbound = Some(out.filled().to_vec());
                    }
                }
                Stage::Reactivating {
                    seq,
                    activation_factory,
                    io_channel_id,
                    ..
                } => {
                    let act_state = seq.connection_activation_state();
                    if pdu_info.action == Action::FastPath {
                        // Drop stale FastPath frames belonging to the deactivated resolution;
                        // defer FastPath frames arriving after ServerDemandActive.
                        if matches!(
                            act_state,
                            ConnectionActivationState::ConnectionFinalization { .. }
                        ) {
                            self.deferred_frames.push_back((Action::FastPath, frame));
                        }
                        continue;
                    }

                    let kind = classify_x224_frame(&frame, *io_channel_id);
                    match kind {
                        X224FrameKind::Disconnect(reason) => {
                            let msg = reason.description().to_owned();
                            self.emit_terminate(&msg);
                            break;
                        }
                        X224FrameKind::FatalErrorInfo(desc) => {
                            self.emit_terminate(&desc);
                            break;
                        }
                        X224FrameKind::NonIoChannel => {
                            // Preserve SVC / DVC / clipboard traffic across reactivation
                            self.deferred_frames.push_back((Action::X224, frame));
                            continue;
                        }
                        X224FrameKind::DeactivateAll => {
                            if matches!(
                                act_state,
                                ConnectionActivationState::ConnectionFinalization { .. }
                            ) {
                                // Server initiated a fresh DeactivateAll mid-finalization;
                                // keep only non-IO SVC frames and restart CapabilitiesExchange.
                                let io_id = *io_channel_id;
                                self.deferred_frames.retain(|(act, f)| {
                                    *act == Action::X224
                                        && matches!(
                                            classify_x224_frame(f, io_id),
                                            X224FrameKind::NonIoChannel
                                        )
                                });
                                **seq = activation_factory.create();
                            }
                            continue;
                        }
                        X224FrameKind::ActiveSessionData => {
                            if matches!(
                                act_state,
                                ConnectionActivationState::ConnectionFinalization { .. }
                            ) {
                                // xrdp often sends Pointer / SetKeyboardIndicators / SaveSessionInfo
                                // before FontMap; defer them until ActiveStage resumes.
                                self.deferred_frames.push_back((Action::X224, frame));
                            }
                            continue;
                        }
                        X224FrameKind::OtherShareData | X224FrameKind::IoMultitransport => {
                            continue;
                        }
                        X224FrameKind::FinalizationData | X224FrameKind::ErrorInfoNone => {
                            if matches!(act_state, ConnectionActivationState::CapabilitiesExchange)
                            {
                                // Stale PDU from previous share before DemandActive
                                continue;
                            }
                        }
                        X224FrameKind::DemandActive | X224FrameKind::OtherHandshake => {}
                    }

                    let prev_state = seq.state().name();
                    let mut out = WriteBuf::new();
                    let written = seq
                        .step(&frame, &mut out)
                        .map_err(|e| format!("RDP reactivation step failed ({prev_state}): {e}"))?;
                    let next_state = seq.state().name();
                    if prev_state != next_state {
                        log_line = Some(format!("Reactivation PDU: {prev_state} -> {next_state}"));
                    }
                    if written.size().is_some() {
                        outbound = Some(out.filled().to_vec());
                    }
                }
                Stage::Active { .. } => {
                    self.process_active_frame(pdu_info.action, &frame)?;
                    continue;
                }
                Stage::Terminated => break,
            }

            if let Some(line) = log_line {
                self.emit_log(&line);
            }
            if let Some(bytes) = outbound {
                self.emit_send(0, &bytes);
            }
            self.drive_no_input_steps()?;
        }

        self.flush_clipboard_actions()?;
        self.flush_pending_resize();
        Ok(())
    }

    fn process_active_frame(&mut self, action: Action, frame: &[u8]) -> Result<(), String> {
        if action == Action::X224 {
            let io_channel_id = match &self.stage {
                Stage::Active { io_channel_id, .. } => *io_channel_id,
                _ => return Ok(()),
            };

            match classify_x224_frame(frame, io_channel_id) {
                X224FrameKind::DeactivateAll => {
                    // Intercepts both XRDP's 6-byte header-only DeactivateAll PDU (which omits shareId
                    // and would otherwise fail ShareControlHeader::decode) and standard 10/13-byte forms!
                    return self.start_reactivation();
                }
                X224FrameKind::Disconnect(reason) => {
                    let msg = reason.description().to_owned();
                    self.emit_terminate(&msg);
                    return Ok(());
                }
                X224FrameKind::FinalizationData | X224FrameKind::OtherShareData => {
                    // Safely ignore redundant Synchronize/Control/FontMap/PlaySound PDUs in ActiveStage
                    return Ok(());
                }
                _ => {}
            }
        }

        let outputs = {
            let Stage::Active { stage, .. } = &mut self.stage else {
                return Ok(());
            };
            stage
                .process(&mut self.image, action, frame)
                .map_err(|e| format!("RDP session error ({action:?}, {} bytes): {e}", frame.len()))?
        };

        self.handle_stage_outputs(outputs)?;
        self.flush_clipboard_actions()?;
        self.flush_pending_resize();
        Ok(())
    }

    fn handle_stage_outputs(&mut self, outputs: Vec<ActiveStageOutput>) -> Result<(), String> {
        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => {
                    self.emit_send(0, &frame);
                }
                ActiveStageOutput::GraphicsUpdate(rect) => {
                    self.rendered_frames += 1;
                    if self.rendered_frames == 1 {
                        self.emit_log(&format!(
                            "Rendered first desktop graphics update ({}..{}, {}..{})",
                            rect.left, rect.right, rect.top, rect.bottom
                        ));
                    }
                    self.blit_rect(&rect);
                }
                ActiveStageOutput::PointerDefault => {
                    let _ = self.cb.on_cursor.call1(&JsValue::NULL, &JsValue::from(0u32));
                }
                ActiveStageOutput::PointerHidden => {
                    let _ = self.cb.on_cursor.call1(&JsValue::NULL, &JsValue::from(1u32));
                }
                ActiveStageOutput::PointerPosition { .. } => {}
                ActiveStageOutput::PointerBitmap(pointer) => {
                    let arr = Uint8Array::from(pointer.bitmap_data.as_slice());
                    let args = js_sys::Array::new();
                    args.push(&JsValue::from(2u32));
                    args.push(&arr);
                    args.push(&JsValue::from(u32::from(pointer.width)));
                    args.push(&JsValue::from(u32::from(pointer.height)));
                    args.push(&JsValue::from(u32::from(pointer.hotspot_x)));
                    args.push(&JsValue::from(u32::from(pointer.hotspot_y)));
                    let _ = self.cb.on_cursor.apply(&JsValue::NULL, &args);
                }
                ActiveStageOutput::DeactivateAll => {
                    self.start_reactivation()?;
                    break;
                }
                ActiveStageOutput::Terminate(reason) => {
                    let msg = reason.to_string();
                    self.emit_terminate(&msg);
                    break;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn blit_rect(&mut self, rect: &InclusiveRectangle) {
        let img_w = self.image.width();
        let img_h = self.image.height();
        if img_w == 0 || img_h == 0 || rect.left >= img_w || rect.top >= img_h {
            return;
        }

        let left = usize::from(rect.left);
        let top = usize::from(rect.top);
        let right = usize::from(rect.right.min(img_w - 1));
        let bottom = usize::from(rect.bottom.min(img_h - 1));
        if right < left || bottom < top {
            return;
        }

        let w = right - left + 1;
        let h = bottom - top + 1;
        let bpp = 4usize;
        let row_bytes = w * bpp;
        let stride = self.image.stride();
        let src = self.image.data();

        self.blit_buf.clear();
        self.blit_buf.reserve(row_bytes * h);

        for row in 0..h {
            let start = (top + row) * stride + left * bpp;
            let end = start + row_bytes;
            if end <= src.len() {
                self.blit_buf.extend_from_slice(&src[start..end]);
            }
        }

        if self.blit_buf.len() == row_bytes * h {
            let arr = Uint8Array::from(self.blit_buf.as_slice());
            let args = js_sys::Array::of5(
                &arr,
                &JsValue::from(left as u32),
                &JsValue::from(top as u32),
                &JsValue::from(w as u32),
                &JsValue::from(h as u32),
            );
            let _ = self.cb.on_draw_rect.apply(&JsValue::NULL, &args);
        }
    }

    fn flush_clipboard_actions(&mut self) -> Result<(), String> {
        let pending: Vec<ClipAction> = {
            let Ok(mut guard) = self.clip_state.lock() else {
                return Ok(());
            };
            guard.actions.drain(..).collect()
        };

        if pending.is_empty() {
            return Ok(());
        }

        if !matches!(self.stage, Stage::Active { .. }) {
            if let Ok(mut guard) = self.clip_state.lock() {
                for item in pending.into_iter().rev() {
                    guard.actions.push_front(item);
                }
            }
            return Ok(());
        }

        let mut outbound_frames: Vec<Vec<u8>> = Vec::new();
        let mut remote_texts: Vec<String> = Vec::new();

        {
            let Stage::Active { stage, .. } = &mut self.stage else {
                return Ok(());
            };
            for action in pending {
                match action {
                    ClipAction::SendInitialFormatList => {
                        let has_local = self
                            .clip_state
                            .lock()
                            .map(|g| !g.local_text.is_empty())
                            .unwrap_or(false);
                        let formats = if has_local {
                            vec![ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)]
                        } else {
                            Vec::new()
                        };
                        if let Some(cliprdr) = stage.get_svc_processor_mut::<CliprdrClient>()
                            && let Ok(msgs) = cliprdr.initiate_copy(&formats)
                            && let Ok(frame) = stage.process_svc_processor_messages(msgs)
                        {
                            outbound_frames.push(frame);
                        }
                    }
                    ClipAction::RequestPasteFormat(fmt_id) => {
                        if let Some(cliprdr) = stage.get_svc_processor_mut::<CliprdrClient>()
                            && let Ok(msgs) = cliprdr.initiate_paste(fmt_id)
                            && let Ok(frame) = stage.process_svc_processor_messages(msgs)
                        {
                            outbound_frames.push(frame);
                        }
                    }
                    ClipAction::SendFormatData(resp) => {
                        if let Some(cliprdr) = stage.get_svc_processor_mut::<CliprdrClient>()
                            && let Ok(msgs) = cliprdr.submit_format_data(resp)
                            && let Ok(frame) = stage.process_svc_processor_messages(msgs)
                        {
                            outbound_frames.push(frame);
                        }
                    }
                    ClipAction::RemoteTextReady(text) => {
                        remote_texts.push(text);
                    }
                }
            }
        }

        for frame in outbound_frames {
            self.emit_send(0, &frame);
        }
        for text in remote_texts {
            let _ = self
                .cb
                .on_clipboard
                .call1(&JsValue::NULL, &JsValue::from_str(&text));
        }

        Ok(())
    }

    fn apply_input(&mut self, ops: impl IntoIterator<Item = Operation>) {
        let outputs = {
            let Stage::Active { stage, .. } = &mut self.stage else {
                return;
            };
            let events = self.input_db.apply(ops);
            if events.is_empty() {
                return;
            };
            stage.process_fastpath_input(&mut self.image, &events).ok()
        };
        if let Some(outputs) = outputs {
            let _ = self.handle_stage_outputs(outputs);
        }
    }
}

fn classify_x224_frame(frame: &[u8], io_channel_id: u16) -> X224FrameKind {
    let Ok(x224) = ironrdp_core::decode::<X224<mcs::McsMessage<'_>>>(frame) else {
        return X224FrameKind::OtherHandshake;
    };

    match x224.0 {
        mcs::McsMessage::DisconnectProviderUltimatum(ult) => {
            X224FrameKind::Disconnect(ult.reason)
        }
        mcs::McsMessage::SendDataIndication(ind) => {
            if ind.channel_id != io_channel_id {
                return X224FrameKind::NonIoChannel;
            }

            let user_data = ind.user_data;

            // Check Multitransport header on IO channel
            if user_data.len() >= BASIC_SECURITY_HEADER_SIZE {
                let flags_raw = u16::from_le_bytes([user_data[0], user_data[1]]);
                let flags_hi = u16::from_le_bytes([user_data[2], user_data[3]]);
                if flags_hi == 0
                    && let Some(flags) = BasicSecurityHeaderFlags::from_bits(flags_raw)
                    && flags.contains(BasicSecurityHeaderFlags::TRANSPORT_REQ)
                {
                    return X224FrameKind::IoMultitransport;
                }
            }

            // Inspect ShareControlHeader 6-byte prefix (totalLength:u16, pduType:u16, pduSource:u16).
            // XRDP sends a 6-byte DeactivateAll PDU without shareId (0x06, 0x00, 0x16, 0x00, ...).
            if user_data.len() >= 6 {
                let pdu_type_raw = u16::from_le_bytes([user_data[2], user_data[3]]);
                let version = pdu_type_raw & !0x000F;
                let pdu_type = pdu_type_raw & 0x000F;
                if version == 0x0010 {
                    match pdu_type {
                        0x0006 => return X224FrameKind::DeactivateAll,
                        0x0001 => return X224FrameKind::DemandActive,
                        0x0007 => {
                            if let Ok(data_ctx) = mcs::decode_send_data_indication(frame)
                                && let Ok(share_ctx) = decode_share_data(data_ctx)
                            {
                                return match share_ctx.pdu {
                                    ShareDataPdu::Synchronize(_)
                                    | ShareDataPdu::Control(_)
                                    | ShareDataPdu::FontMap(_) => X224FrameKind::FinalizationData,
                                    ShareDataPdu::ServerSetErrorInfo(ServerSetErrorInfoPdu(
                                        ErrorInfo::ProtocolIndependentCode(
                                            ProtocolIndependentCode::None,
                                        ),
                                    )) => X224FrameKind::ErrorInfoNone,
                                    ShareDataPdu::ServerSetErrorInfo(ServerSetErrorInfoPdu(
                                        err,
                                    )) => X224FrameKind::FatalErrorInfo(err.description()),
                                    ShareDataPdu::Update(_)
                                    | ShareDataPdu::Pointer(_)
                                    | ShareDataPdu::SaveSessionInfo(_)
                                    | ShareDataPdu::SetKeyboardIndicators(_)
                                    | ShareDataPdu::ShutdownDenied => {
                                        X224FrameKind::ActiveSessionData
                                    }
                                    _ => X224FrameKind::OtherShareData,
                                };
                            }
                        }
                        _ => {}
                    }
                }
            }

            X224FrameKind::OtherHandshake
        }
        _ => X224FrameKind::OtherHandshake,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_pdu::mcs::SendDataIndication;
    use ironrdp_pdu::rdp::finalization_messages::FontPdu;
    use ironrdp_pdu::rdp::headers::{ServerDeactivateAll, ShareControlPdu, encode_share_control, encode_share_data};
    use std::borrow::Cow;

    fn wrap_send_data_indication(initiator_id: u16, channel_id: u16, payload: &[u8]) -> Vec<u8> {
        let msg = mcs::McsMessage::SendDataIndication(SendDataIndication {
            initiator_id,
            channel_id,
            user_data: Cow::Borrowed(payload),
        });
        ironrdp_core::encode_vec(&X224(msg)).expect("encode SendDataIndication")
    }

    #[test]
    fn classifies_xrdp_compact_6_byte_deactivate_all() {
        // XRDP sends a 6-byte ShareControlHeader for DeactivateAll omitting shareId and sourceDescriptor
        let xrdp_short_deactivate: [u8; 6] = [0x06, 0x00, 0x16, 0x00, 0xea, 0x03];
        let frame = wrap_send_data_indication(1002, 1003, &xrdp_short_deactivate);

        assert!(matches!(
            classify_x224_frame(&frame, 1003),
            X224FrameKind::DeactivateAll
        ));
    }

    #[test]
    fn classifies_standard_deactivate_all_and_share_data_pdus() {
        // Standard 13-byte ServerDeactivateAll
        let mut buf = WriteBuf::new();
        encode_share_control(
            1002,
            1003,
            0x0001_03ea,
            ShareControlPdu::ServerDeactivateAll(ServerDeactivateAll),
            &mut buf,
        )
        .unwrap();
        // Convert SendDataRequest (0x64 = domainMCSPDU 25) to SendDataIndication (0x68 = domainMCSPDU 26)
        let mut std_deact = buf.filled().to_vec();
        std_deact[7] = (26 << 2) | (std_deact[7] & 0x03);
        assert!(matches!(
            classify_x224_frame(&std_deact, 1003),
            X224FrameKind::DeactivateAll
        ));

        // Non-IO channel SVC frame
        let svc_frame = wrap_send_data_indication(1002, 1005, &[1, 2, 3, 4]);
        assert!(matches!(
            classify_x224_frame(&svc_frame, 1003),
            X224FrameKind::NonIoChannel
        ));

        // FontMap finalization frame
        buf.clear();
        encode_share_data(1002, 1003, 0x0001_03ea, ShareDataPdu::FontMap(FontPdu::default()), &mut buf)
            .unwrap();
        let mut font_map = buf.filled().to_vec();
        font_map[7] = (26 << 2) | (font_map[7] & 0x03);
        assert!(matches!(
            classify_x224_frame(&font_map, 1003),
            X224FrameKind::FinalizationData
        ));
    }

    #[test]
    fn narrow_window_layout_preserves_landscape_orientation() {
        let (w, h) = MonitorLayoutEntry::adjust_display_size(801, 960);
        assert_eq!((w, h), (800, 960));
        let entry = MonitorLayoutEntry::new_primary(w, h)
            .unwrap()
            .with_orientation(MonitorOrientation::Landscape);
        assert_eq!(entry.orientation(), Some(MonitorOrientation::Landscape));
        let layout = DisplayControlMonitorLayout::new(&[entry]).unwrap();
        assert_eq!(layout.monitors().len(), 1);
    }
}
