"""Issue #104: empty-message mDNS exceptions must log their class repr."""

import pytest

from backend.agent import discovery


@pytest.fixture()
def _reset_advertising():
    discovery._zc = None
    discovery._info = None
    yield
    discovery._zc = None
    discovery._info = None


class _EmptyError(Exception):
    def __str__(self):
        return ""


def test_start_advertising_logs_repr_for_empty_message(
    monkeypatch, caplog, _reset_advertising
):
    """A zeroconf failure with an empty str() still logs the exception class."""

    def _boom(*args, **kwargs):
        raise _EmptyError()

    monkeypatch.setattr(discovery, "Zeroconf", _boom)
    monkeypatch.setattr(discovery, "ServiceInfo", lambda *a, **k: object())
    monkeypatch.setattr(discovery, "_local_ip", lambda: "127.0.0.1")

    with caplog.at_level("WARNING", logger="backend.agent.discovery"):
        # Must not raise: advertising is best-effort.
        discovery.start_advertising(8765)

    warnings = [r for r in caplog.records if "mDNS advertising failed" in r.message]
    assert len(warnings) == 1
    assert "_EmptyError" in warnings[0].getMessage()
