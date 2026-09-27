"""Issue #112: a Windows Sandbox toggle in Settings.

The config round-trips through PUT/GET /api/config (sandbox block merges so
partial saves don't wipe sibling keys), and GET /api/sandbox/status exposes
feature availability (WindowsSandbox.exe present) so the toggle can show the
enable command + BIOS hint when the Windows feature is missing.
"""
import pytest
from fastapi.testclient import TestClient

from backend.agent.config import load_config


@pytest.fixture
def client(tmp_path, monkeypatch):
    from backend.agent import config as cfgmod

    monkeypatch.setattr(cfgmod, "CONFIG_PATH", tmp_path / "config.json")
    import backend.main as mainmod

    monkeypatch.setattr(mainmod, "load_config", cfgmod.load_config)
    monkeypatch.setattr(mainmod, "save_config", cfgmod.save_config)
    from backend.main import app

    with TestClient(app) as c:
        yield c


def test_sandbox_block_roundtrips_and_persists(client, monkeypatch):
    """PUT /api/config merges the sandbox block and GET returns it."""
    monkeypatch.setenv("YAAH_SANDBOX_EXE", "")
    r = client.put("/api/config", json={"sandbox": {"enabled": False}})
    assert r.status_code == 200

    cfg = load_config()
    assert cfg["sandbox"]["enabled"] is False
    # Partial save must not wipe sibling keys of the stored block.
    assert cfg["sandbox"]["memory_mb"] == 8192

    got = client.get("/api/config").json()
    assert got["sandbox"]["enabled"] is False
    assert got["sandbox"]["memory_mb"] == 8192


def test_sandbox_status_endpoint(client, monkeypatch, tmp_path):
    """GET /api/sandbox/status reports feature availability + config state."""
    from backend.agent import sandbox as sb

    monkeypatch.setattr(sb, "sandbox_exe", lambda: None)
    monkeypatch.setattr(sb, "_alive", lambda: False)
    r = client.get("/api/sandbox/status")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    # The enable guidance is surfaced for the UI to render (issue #112).
    assert "Enable-WindowsOptionalFeature" in body["enable_command"]
    assert "Containers-DisposableClientVM" in body["enable_command"]
    # BIOS virtualization hint, so users don't blame the feature flag.
    assert "virtualization" in body["bios_hint"].lower()

    # With the feature present, available flips true.
    fake = tmp_path / "WindowsSandbox.exe"
    fake.write_bytes(b"x")
    monkeypatch.setattr(sb, "sandbox_exe", lambda: fake)
    body = client.get("/api/sandbox/status").json()
    assert body["available"] is True
