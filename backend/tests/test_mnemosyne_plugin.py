
"""Tests for the Mnemosyne memory plugin (opt-in, off by default).

Uses a throwaway ``$MNEMOSYNE_DATA_DIR`` per test — real YAAH/Hermes memory
is never touched. Skipped entirely when ``mnemosyne`` isn't installed.
"""

import json
import os
import re

import pytest

mnemosyne = pytest.importorskip("mnemosyne")

from backend.agent import mnemosyne_plugin as plugin

WORKSPACE = "/tmp/fake-workspace"


@pytest.fixture(autouse=True)
def _fresh_instances():
    """Simulate a fresh process per test: drop cached SDK instances.

    The plugin keys instances by (data_dir, bank); without this, one test's
    instances would leak into the next test's throwaway data dir.
    """
    plugin._instances.clear()
    yield
    plugin._instances.clear()


@pytest.fixture()
def mem_env(tmp_path, monkeypatch):
    """Isolated Mnemosyne data dir for one test."""
    d = tmp_path / "mnemo-data"
    d.mkdir()
    monkeypatch.setenv("MNEMOSYNE_DATA_DIR", str(d))
    return d


@pytest.fixture()
def enabled(monkeypatch):
    monkeypatch.setattr(
        plugin, "_plugin_config", lambda: {"enabled": True, "top_k": 8}
    )


@pytest.fixture()
def disabled(monkeypatch):
    monkeypatch.setattr(plugin, "_plugin_config", lambda: {"enabled": False})


def _remember(content, bank, importance=0.8):
    return plugin._get_instance(bank).remember(content, importance=importance)


def _recall_bank(query, bank, top_k=5):
    return plugin._get_instance(bank).recall(query, top_k=top_k) or []


# ---------------------------------------------------------------------------
# Gating
# ---------------------------------------------------------------------------


def test_disabled_recall_returns_empty(disabled, mem_env):
    assert plugin.is_enabled() is False
    assert plugin.recall_block("anything", WORKSPACE) == ("", None)


def test_disabled_retain_is_noop(disabled, mem_env):
    assert plugin.retain_turn("remember this: x", WORKSPACE) == 0


def test_enabled_flag(enabled):
    assert plugin.is_enabled() is True


# ---------------------------------------------------------------------------
# Banks
# ---------------------------------------------------------------------------


def test_bank_names_are_sdk_valid(enabled, mem_env):
    proj = plugin.project_bank(WORKSPACE)
    assert proj != plugin.GLOBAL_BANK
    assert re.fullmatch(r"[A-Za-z0-9\-_]{1,64}", proj)
    assert re.fullmatch(r"[A-Za-z0-9\-_]{1,64}", plugin.GLOBAL_BANK)
    # stable per workspace, distinct across workspaces
    assert plugin.project_bank(WORKSPACE) == proj
    assert plugin.project_bank("/other/ws") != proj


def test_bank_isolation_is_strict(enabled, mem_env):
    """SDK-level proof that fan-out is required: banks don't leak."""
    _remember("project secret sauce uses tabs", plugin.project_bank(WORKSPACE))
    _remember("global fact: the sky is blue", plugin.GLOBAL_BANK)
    proj_hits = _recall_bank("secret sauce", plugin.project_bank(WORKSPACE))
    assert not any("sky is blue" in h["content"] for h in proj_hits)
    glob_hits = _recall_bank("sky is blue", plugin.GLOBAL_BANK)
    assert not any("secret sauce" in h["content"] for h in glob_hits)


# ---------------------------------------------------------------------------
# Recall
# ---------------------------------------------------------------------------


def test_recall_fans_out_and_merges(enabled, mem_env):
    _remember("the user prefers dark mode", plugin.project_bank(WORKSPACE), 0.9)
    _remember("the user is named Brian", plugin.GLOBAL_BANK, 0.9)
    block, event = plugin.recall_block("the user", WORKSPACE)
    assert "dark mode" in block
    assert "Brian" in block
    assert event is not None
    assert event["type"] == "memory_recall"
    assert event["source"] == "mnemosyne"
    assert event["count"] == 2
    assert plugin.project_bank(WORKSPACE) in event["banks"]
    assert plugin.GLOBAL_BANK in event["banks"]
    assert len(event["items"]) == 2


def test_recall_dedupes_across_banks(enabled, mem_env):
    _remember("the user prefers dark mode", plugin.project_bank(WORKSPACE), 0.9)
    _remember("the user prefers dark mode", plugin.GLOBAL_BANK, 0.9)
    block, event = plugin.recall_block("user preferences", WORKSPACE)
    assert block.count("dark mode") == 1
    assert event["count"] == 1


def test_recall_empty_when_nothing_stored(enabled, mem_env):
    assert plugin.recall_block("user preferences", WORKSPACE) == ("", None)


def test_recall_empty_query_uses_generic(enabled, mem_env):
    _remember("the user prefers dark mode", plugin.GLOBAL_BANK, 0.9)
    block, event = plugin.recall_block("", WORKSPACE)
    assert "dark mode" in block
    assert event["count"] >= 1


def test_third_person_rewrite():
    assert plugin._third_person("who am I?") == "who is the user?"
    assert plugin._third_person("what is my name") == "what is the user's name"
    assert plugin._third_person("I'm hungry") == "the user is hungry"


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------


def test_retain_stores_triggered_fact_in_project_bank(enabled, mem_env):
    n = plugin.retain_turn(
        "remember this: the build needs tabs, not spaces",
        WORKSPACE,
    )
    assert n == 1
    hits = _recall_bank("build needs tabs", plugin.project_bank(WORKSPACE))
    assert any("tabs" in h["content"] for h in hits)
    # ... and NOT in the global bank
    ghits = _recall_bank("build needs tabs", plugin.GLOBAL_BANK)
    assert not any("tabs, not spaces" in h["content"] for h in ghits)


def test_retain_routes_identity_to_global_bank(enabled, mem_env):
    n = plugin.retain_turn("my name is Brian", WORKSPACE)
    assert n == 1
    hits = _recall_bank("what is the user's name", plugin.GLOBAL_BANK)
    assert any("Brian" in h["content"] for h in hits)


def test_retain_ignores_chatter(enabled, mem_env):
    n = plugin.retain_turn(
        "what's the weather like today",
        WORKSPACE,
    )
    assert n == 0


def test_retain_never_mines_assistant_text(enabled, mem_env):
    """Assistant wording — even trigger-shaped — must not become facts."""
    # retain_turn no longer takes assistant text at all: the signature
    # itself is the guard. Belt-and-braces: a user turn with no triggers
    # stores nothing even when the assistant said something trigger-like.
    n = plugin.retain_turn("ok thanks", WORKSPACE)
    assert n == 0
    assert _recall_bank("tabs", plugin.project_bank(WORKSPACE)) == []
    assert _recall_bank("dark mode", plugin.GLOBAL_BANK) == []


def test_retain_natural_pet_fact(enabled, mem_env):
    """Natural talk — 'I had a dog named Sasha' — is stored, like a friend."""
    n = plugin.retain_turn(
        "Yeah, I had a dog named Sasha. She passed almost two years ago.",
        WORKSPACE,
    )
    assert n == 1
    hits = _recall_bank("what is my dog's name", plugin.GLOBAL_BANK)
    assert any("Sasha" in h["content"] for h in hits)


def test_retain_natural_name_is_pattern(enabled, mem_env):
    assert plugin.retain_turn("my dog's name is Biscuit", WORKSPACE) == 1
    hits = _recall_bank("dog's name", plugin.GLOBAL_BANK)
    assert any("Biscuit" in h["content"] for h in hits)


def test_retain_capitalized_name_only(enabled, mem_env):
    """'my dog is Sasha' stores; 'my dog is sick' (transient) does not."""
    assert plugin.retain_turn("my dog is Sasha", WORKSPACE) == 1
    assert plugin.retain_turn("my dog is sick today", WORKSPACE) == 0


def test_retain_natural_tastes_and_habits(enabled, mem_env):
    assert plugin.retain_turn("I love shooting portraits at golden hour", WORKSPACE) == 1
    assert plugin.retain_turn("I usually edit late at night", WORKSPACE) == 1
    assert plugin.retain_turn("I live in Loganville, Georgia", WORKSPACE) == 1


def test_retain_ignores_questions_opinions_transience(enabled, mem_env):
    """Questions, opinions, demonstratives, and transient states: never."""
    assert plugin.retain_turn("do you remember my dog's name?", WORKSPACE) == 0
    assert plugin.retain_turn("I think this looks good", WORKSPACE) == 0
    assert plugin.retain_turn("I like this approach", WORKSPACE) == 0
    assert plugin.retain_turn("I'm a bit tired today", WORKSPACE) == 0
    assert plugin.retain_turn("what's the weather like today", WORKSPACE) == 0


def test_retain_explicit_bypasses_junk_filter(enabled, mem_env):
    """'remember this' means it — even opinion-shaped content is honored."""
    assert plugin.retain_turn("remember this: I think tabs are better", WORKSPACE) == 1


def test_retain_skips_near_duplicates(enabled, mem_env):
    assert plugin.retain_turn("remember this: use tabs", WORKSPACE) == 1
    assert plugin.retain_turn("remember this: use tabs", WORKSPACE) == 0


def test_retain_cleans_meta_scaffolding(enabled, mem_env):
    plugin.retain_turn("remember this: the API key rotation is monthly", WORKSPACE)
    hits = _recall_bank("API key rotation", plugin.project_bank(WORKSPACE))
    assert hits
    assert not hits[0]["content"].lower().startswith("remember this")


# ---------------------------------------------------------------------------
# Sleep / consolidation
# ---------------------------------------------------------------------------


def test_sleep_due_initially_and_not_after_run(enabled, mem_env, monkeypatch):
    # keep the interval huge so "due" flips only via the stamp file
    monkeypatch.setattr(plugin, "_sleep_interval_hours", lambda: 24 * 365)
    assert plugin.sleep_due() is True
    plugin.retain_turn("remember this: use tabs", WORKSPACE)
    summary = plugin.run_sleep(WORKSPACE)
    assert summary[plugin.project_bank(WORKSPACE)]["ok"] is True
    assert summary[plugin.GLOBAL_BANK]["ok"] is True
    stamp = mem_env / "last_sleep.json"
    assert stamp.exists()
    assert json.loads(stamp.read_text())["ts"] > 0
    assert plugin.sleep_due() is False


def test_run_sleep_never_raises_with_bad_workspace(enabled, mem_env):
    # bank names are sanitized; garbage in -> still a valid bank, no raise
    summary = plugin.run_sleep("///")
    assert all(v["ok"] for v in summary.values())


# ---------------------------------------------------------------------------
# Failure safety
# ---------------------------------------------------------------------------


def test_recall_survives_sdk_failure(enabled, mem_env, monkeypatch):
    def boom(bank):
        raise RuntimeError("sdk exploded")

    monkeypatch.setattr(plugin, "_get_instance", boom)
    assert plugin.recall_block("x", WORKSPACE) == ("", None)


def test_retain_survives_sdk_failure(enabled, mem_env, monkeypatch):
    def boom(bank):
        raise RuntimeError("sdk exploded")

    monkeypatch.setattr(plugin, "_get_instance", boom)
    assert plugin.retain_turn("remember this: use tabs", WORKSPACE) == 0


def test_is_enabled_survives_config_failure(monkeypatch):
    monkeypatch.setattr(
        plugin, "_plugin_config", lambda: (_ for _ in ()).throw(RuntimeError("nope"))
    )
    assert plugin.is_enabled() is False
