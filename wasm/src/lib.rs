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
use ironrdp_dvc::DrdynvcClient;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_input::{
    Database as InputDatabase, MouseButton, MousePosition, Operation, Scancode, WheelRotations,
};
use ironrdp_pdu::gcc::KeyboardType;
use ironrdp_pdu::geometry::InclusiveRectangle;
use ironrdp_pdu::mcs;
use ironrdp_pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp_pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp_pdu::x224::X224;
use ironrdp_pdu::{Action, find_size};
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
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
        let clip_backend = Box::new(WasmClipBackend {
            shared: Arc::clone(&clip_state),
        });
        let cliprdr = CliprdrClient::new(clip_backend);
        let dvc =
            DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_caps| Ok(Vec::new())));

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
        let frame_opt = {
            let Stage::Active { stage, .. } = &mut self.stage else {
                return;
            };
            let adj_w = width.clamp(320, 4096) & !1;
            let adj_h = height.clamp(240, 4096);
            if adj_w == u32::from(self.image.width()) && adj_h == u32::from(self.image.height()) {
                return;
            }
            stage.encode_resize(adj_w, adj_h, None, None)
        };
        if let Some(Ok(frame)) = frame_opt {
            self.emit_log(&format!("Requested DisplayControl resize to {width}x{height}"));
            self.emit_send(0, &frame);
        }
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
                ..
            } = seq.connection_activation_state()
            {
                stage.set_share_id(share_id);
                self.emit_log(&format!(
                    "Completed Deactivate-Reactivate sequence ({}x{}, share_id={share_id})",
                    desktop_size.width, desktop_size.height
                ));
                if desktop_size.width != self.image.width() || desktop_size.height != self.image.height() {
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
            }

            self.stage = Stage::Active {
                stage,
                activation_factory,
                io_channel_id,
            };

            self.drain_deferred_frames()?;
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
                        if is_non_io_svc_indication(&frame, expected_io) {
                            self.deferred_frames.push_back((Action::X224, frame));
                            continue;
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
                    seq, io_channel_id, ..
                } => {
                    if pdu_info.action == Action::FastPath
                        || is_non_io_svc_indication(&frame, *io_channel_id)
                    {
                        self.deferred_frames.push_back((pdu_info.action, frame));
                        continue;
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
        Ok(())
    }

    fn process_active_frame(&mut self, action: Action, frame: &[u8]) -> Result<(), String> {
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
                    self.emit_log("Received Server DeactivateAll PDU; starting reactivation");
                    let Stage::Active {
                        stage,
                        activation_factory,
                        io_channel_id,
                    } = core::mem::replace(&mut self.stage, Stage::Terminated)
                    else {
                        break;
                    };
                    let seq = activation_factory.create();
                    self.stage = Stage::Reactivating {
                        seq: Box::new(seq),
                        stage,
                        activation_factory,
                        io_channel_id,
                    };
                    self.drive_no_input_steps()?;
                    break;
                }
                ActiveStageOutput::Terminate(reason) => {
                    let msg = reason.to_string();
                    self.emit_log(&format!(
                        "Session terminated by server (rendered_frames={}): {msg}",
                        self.rendered_frames
                    ));
                    self.stage = Stage::Terminated;
                    let _ = self
                        .cb
                        .on_terminated
                        .call1(&JsValue::NULL, &JsValue::from_str(&msg));
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
            }
            stage.process_fastpath_input(&mut self.image, &events).ok()
        };
        if let Some(outputs) = outputs {
            let _ = self.handle_stage_outputs(outputs);
        }
    }
}

fn is_non_io_svc_indication(frame: &[u8], io_channel_id: u16) -> bool {
    if let Ok(x224) = ironrdp_core::decode::<X224<mcs::McsMessage<'_>>>(frame)
        && let mcs::McsMessage::SendDataIndication(ind) = x224.0
    {
        return ind.channel_id != io_channel_id;
    }
    false
}
