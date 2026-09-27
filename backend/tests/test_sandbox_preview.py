"""Lifecycle tests for the optional Windows Sandbox preview manager."""

import threading

from backend.agent import sandbox_preview as preview


def test_start_preview_skips_non_windows_and_headless(monkeypatch):
    monkeypatch.setattr(preview, "_manager", None)
    monkeypatch.setattr(preview.os, "name", "posix")
    assert preview.start_preview() is False
    assert preview._manager is None

    monkeypatch.setattr(preview.os, "name", "nt")
    monkeypatch.setenv("YAAH_HEADLESS", "1")
    assert preview.start_preview() is False
    assert preview._manager is None


def test_start_preview_is_idempotent_and_stop_releases_manager(monkeypatch):
    monkeypatch.setattr(preview.os, "name", "nt")
    monkeypatch.delenv("YAAH_HEADLESS", raising=False)
    monkeypatch.setattr(preview, "_manager", None)
    events = []

    class FakeManager:
        running = True
        stopping = False

        def start(self):
            events.append("start")

        def stop(self):
            events.append("stop")
            self.running = False
            self.stopping = True

    monkeypatch.setattr(preview, "_PreviewManager", FakeManager)
    assert preview.start_preview() is True
    first_manager = preview._manager
    assert preview.start_preview() is True
    assert preview._manager is first_manager
    assert events == ["start"]

    preview.stop_preview()
    assert preview._manager is None
    assert events == ["start", "stop"]


def test_main_window_selection_prefers_largest_candidate():
    # EnumWindows may report an auxiliary/title-bar HWND before the full client.
    candidates = [(320 * 36, 0x101), (1280 * 720, 0x202), (900 * 600, 0x303)]
    assert preview._select_main_window(candidates) == 0x202


def test_main_window_selection_handles_no_candidates():
    assert preview._select_main_window([]) == 0


def test_manager_stop_signals_and_joins_preview_thread():
    entered = threading.Event()
    release = threading.Event()

    manager = preview._PreviewManager()

    def wait_until_stopped():
        entered.set()
        manager._stop.wait()
        release.set()

    manager._run_native = wait_until_stopped
    manager.start()
    assert entered.wait(timeout=1)
    manager.stop()
    assert release.is_set()
    assert not manager.running


# ---- #116: moveable/resizeable preview + pin-to-yaah ----


def test_fit_thumbnail_rect_letterboxes_inside_client():
    # 16:9 source into a 4:3-ish client -> width-limited, vertically centered.
    left, top, w, h = preview.fit_thumbnail_rect(200, 150, 1600, 900)
    assert (w, h) == (200, 112)
    assert (left, top) == (0, 19)


def test_fit_thumbnail_rect_falls_back_when_source_unknown():
    left, top, w, h = preview.fit_thumbnail_rect(420, 236, 0, 0)
    assert (left, top, w, h) == (0, 0, 420, 236)


def test_pin_offset_anchors_right_edge():
    yaah = (0, 0, 1000, 800)
    prev = (1024, 100, 1444, 336)
    assert preview.pin_offset(yaah, prev) == (24, 100)


def test_pinned_position_reproduces_anchor_after_yaah_moves():
    yaah = (0, 0, 1000, 800)
    prev = (1024, 100, 1444, 336)
    offset = preview.pin_offset(yaah, prev)
    assert preview.pinned_position((200, 300, 1200, 1100), offset) == (1224, 400)


def test_preview_pinned_config_roundtrip(tmp_path, monkeypatch):
    import backend.agent.config as config

    cfg = tmp_path / "config.json"
    # CONFIG_PATH is bound at import (conftest redirects it to a shared
    # temp file); point it at an isolated file for this test.
    monkeypatch.setattr(config, "CONFIG_PATH", cfg)
    assert preview.get_preview_pinned() is False
    preview.set_preview_pinned(True)
    assert preview.get_preview_pinned() is True
    # Other sandbox keys survive the write.
    import json

    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["sandbox"]["enabled"] is True
    assert data["sandbox"]["preview_pinned"] is True


def test_find_yaah_window_uses_exact_title(monkeypatch):
    class FakeUser32:
        def __init__(self):
            self.calls = []

        def FindWindowW(self, cls, title):
            self.calls.append((cls, title))
            return 0x42

    user32 = FakeUser32()
    assert preview._find_yaah_window(user32) == 0x42
    assert user32.calls == [(None, "YAAH")]


def test_find_yaah_window_returns_zero_when_absent():
    class FakeUser32:
        def FindWindowW(self, cls, title):
            return 0

    assert preview._find_yaah_window(FakeUser32()) == 0
