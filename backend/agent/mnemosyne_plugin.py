
"""Mnemosyne semantic-memory plugin for YAAH.

Opt-in (off by default — see ``memory_plugin.enabled`` in Settings). When
enabled:

* **Turn start** — :func:`recall_block` replaces the full ``MEMORY.md`` index
  injection with a semantic snapshot: project bank + global bank are queried,
  merged, and deduplicated. Returns ``(prompt_block, stream_event)`` so the
  loop can emit a truthful ``memory_recall`` event for the visualizer.
* **Turn end** — :func:`retain_turn` captures durable facts into the
  project or global bank. Listens like a friend: explicit "remember this"
  commands plus natural durable-fact shapes (people/pets, identity, tastes,
  habits, conventions). Questions, opinions, and transient chatter are
  ignored.
* **Consolidation** — :func:`run_sleep` moves working memory into episodic
  memory per bank. Triggered opportunistically at turn end when due
  (independent of the scheduler tick), in a daemon thread.

Persistent data lives under ``~/.yaah/mnemosyne/`` (outside PyInstaller's
extraction dir), or ``$MNEMOSYNE_DATA_DIR`` when set.

Every public function is best-effort: any failure degrades to ``("", None)``
/ ``0`` and can never break a user turn.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GLOBAL_BANK = "yaah_global"
_PROJECT_BANK_PREFIX = "yaah_p_"  # + 16-char hex project key -> <= 64 chars
_LAST_SLEEP_FILENAME = "last_sleep.json"

_DEFAULT_TOP_K = 8
_DEFAULT_SLEEP_INTERVAL_HOURS = 6.0

_GENERIC_RECALL_TOKENS = ("user", "project")

_MAX_FACT_CHARS = 280
_MAX_FACTS_PER_TURN = 3

# Direct commands to the agent — strongest signal, always honored, and the
# only matches that bypass the junk filter ("remember this" means it).
_COMMAND_TRIGGERS = (
    "remember this",
    "remember that",
    "don't forget",
    "do not forget",
    "from now on",
)

# Other explicit durable-fact phrasings (identity, conventions). These still
# go through the junk filter, so "do you always run tests?" (a question)
# is never stored.
_RETAIN_TRIGGERS = (
    "always ",
    "never ",
    "my name is",
    "i'm called",
    "call me",
)

# Natural durable-fact shapes: the user talking like a person, not issuing
# a memory command. Each pattern carries its bank label. Deliberately shaped
# like what a friend would write down — who you are, who you love, what you
# like, how you live — never transient states ("I'm tired"), opinions
# ("I think this is fine"), or questions. Case-insensitive, matched against
# a single sentence.
_RETAIN_PATTERNS: tuple[tuple[str, str], ...] = (
    # People & pets -----------------------------------------------------
    (r"\bmy\s+[\w']+\s+name\s+is\b", "global"),  # my dog's name is Sasha
    # Scoped (?i:...) on the literals so the trailing [A-Z] stays
    # case-SENSITIVE: proper nouns only — "named Sasha" stores,
    # "named standup" does not.
    (r"(?i:\bi\s+had\s+a\s+\w+\s+named\s+)(?-i:[A-Z])", "global"),  # I had a dog named Sasha
    (r"(?i:\bi\s+have\s+a\s+\w+\s+named\s+)(?-i:[A-Z])", "global"),  # I have a cat named Miso
    # my dog is Sasha — capitalized proper noun only, so
    # "my dog is sick" (transient) does NOT match.
    (r"(?i:\bmy\s+(?:dog|cat|pet|son|daughter|wife|husband|partner|mom|dad|mother|father|brother|sister)\s+is\s+)(?-i:[A-Z])", "global"),
    (r"\bmy\s+(?:dog|cat|pet|wife|husband|partner|son|daughter|mom|dad|mother|father|brother|sister)\s+(?:passed\s+away|died)\b", "global"),
    # Identity / bio ----------------------------------------------------
    (r"\bi\s+live\s+in\b", "global"),
    (r"\bi'?m\s+(?:from|based\s+in)\b", "global"),
    (r"\bi\s+work\s+(?:as|at|for)\b", "global"),
    (r"\bmy\s+birthday\s+is\b", "global"),
    (r"\bi\s+was\s+born\b", "global"),
    (r"\bi'?m\s+\d+\s+years\s+old\b", "global"),
    # Tastes ------------------------------------------------------------
    (r"\bi\s+(?:love|adore)\b", "global"),
    (r"\bi\s+(?:like|dislike|hate|prefer)\b", "global"),
    (r"\bi\s+can'?t\s+stand\b", "global"),
    (r"\bi'?m\s+(?:not\s+)?into\b", "global"),
    # Habits / routines -------------------------------------------------
    (r"\bi\s+(?:usually|normally)\b", "global"),
    (r"\bevery\s+(?:morning|day|week|night)\s+i\b", "global"),
    # Possessions -------------------------------------------------------
    (r"\bi\s+(?:drive|own)\s+a\b", "global"),
)

# Sentences matching these are never stored, even when a natural pattern
# hits: questions, opinions, and demonstrative-only objects ("I like this").
# Explicit memory commands bypass this filter — "remember this" means it.
_JUNK_PATTERNS = (
    r"\?\s*$",
    r"^\s*i\s+(?:think|guess|suppose|believe|feel)\b",
    r"\bi\s+(?:like|love|prefer|adore)\s+(?:this|that|it)\b",
)

_RETAIN_RES = tuple(
    (re.compile(p, re.IGNORECASE), label) for p, label in _RETAIN_PATTERNS
)
_JUNK_RES = tuple(re.compile(p, re.IGNORECASE) for p in _JUNK_PATTERNS)

# Triggers that describe the *person* (not the project) -> global bank.
# Everything else triggered goes to the project bank. Recall fans out to
# both banks, so a misfiled fact is still found — it only changes the label.
_GLOBAL_TRIGGERS = (
    "my name is",
    "i'm called",
    "call me",
)

# Leading meta-scaffolding stripped before storing ("remember this: X" -> "X").
# Semantic triggers (always/never/prefer/...) are kept — they carry meaning.
_STRIP_PREFIXES = (
    "remember this",
    "remember that",
    "don't forget",
    "do not forget",
    "from now on",
)

_sleep_lock = threading.Lock()

# Plugin-owned Mnemosyne instances, keyed by (data_dir, bank).
#
# The SDK's module-level remember()/recall() share ONE global singleton that
# only holds a single bank: fanning out across the project and global banks
# thrashes it — every bank switch constructs a new instance and re-resolves
# the data dir, so a write and the subsequent read can land in different
# databases. We keep one instance per bank instead. Instances are created
# lazily on first use and live for the process.
#
# _instances_lock also serializes EVERY Mnemosyne() construction in this
# process — including the fresh instances run_sleep() builds on its daemon
# thread. The SDK's init_db() runs schema migrations (ALTER TABLE ADD
# COLUMN) that are not concurrency-safe: two threads constructing instances
# for the same database at once crash with "duplicate column name".
# One lock for all construction closes that race.
_instances: dict[tuple[str, str], object] = {}
_instances_lock = threading.Lock()


def _get_instance(bank: str):
    """Return the cached Mnemosyne instance for (data_dir, bank)."""
    from mnemosyne import Mnemosyne

    d = data_dir()
    key = (d, bank)
    inst = _instances.get(key)
    if inst is None:
        with _instances_lock:
            inst = _instances.get(key)
            if inst is None:
                # Pin the env var before construction: the SDK resolves the
                # bank's database path from it dynamically at this point.
                os.environ["MNEMOSYNE_DATA_DIR"] = d
                inst = Mnemosyne(bank=bank)
                _instances[key] = inst
    return inst


# ---------------------------------------------------------------------------
# Config / paths / banks
# ---------------------------------------------------------------------------


def _plugin_config() -> dict:
    """The ``memory_plugin`` block from config.json ({} when absent/broken)."""
    try:
        from backend.agent.config import load_config

        cfg = load_config() or {}
        block = cfg.get("memory_plugin")
        return block if isinstance(block, dict) else {}
    except Exception:
        return {}


def is_enabled() -> bool:
    """True only when the user opted in via Settings. Off by default."""
    try:
        return bool(_plugin_config().get("enabled", False))
    except Exception:
        return False


def data_dir() -> str:
    """Persistent Mnemosyne data dir. ``$MNEMOSYNE_DATA_DIR`` wins (tests)."""
    env = os.environ.get("MNEMOSYNE_DATA_DIR")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".yaah", "mnemosyne")


def _ensure_data_dir() -> str:
    """Create our data dir and point the SDK at it. Returns the dir."""
    d = data_dir()
    os.makedirs(d, exist_ok=True)
    # The SDK reads this env var dynamically at call time.
    os.environ.setdefault("MNEMOSYNE_DATA_DIR", d)
    return d


def project_bank(workspace: str) -> str:
    """Stable, SDK-valid bank name for a workspace.

    ``memory.project_key()`` yields a stable 16-char hex digest; sanitized
    defensively to the SDK's ``[alnum-_]{1,64}`` rule.
    """
    from backend.agent.memory import project_key

    key = project_key(workspace or "")
    safe = re.sub(r"[^a-z0-9]", "", str(key).lower())[:16] or "default"
    return f"{_PROJECT_BANK_PREFIX}{safe}"


# ---------------------------------------------------------------------------
# Recall (turn start)
# ---------------------------------------------------------------------------


def _display_content(raw: str) -> str:
    """Human-readable content: strips SDK marker wrappers like
    ``[MEMORIA memoria_preferences]`` / ``[Preference]`` that the
    auto-extraction tier wraps around entries."""
    s = str(raw or "").strip()
    s = re.sub(r"^(?:\[[^\]\n]*\]\s*)+", "", s).strip()
    return s


def _norm_content(raw: str) -> str:
    return re.sub(r"\s+", " ", _display_content(raw).lower())


def _third_person(query: str) -> str:
    """Spike finding: first-person queries ("who am I?") match nothing.

    Light, word-boundary rewrite into third person. Contractions first so
    "I'm" doesn't become "the user'm".
    """
    q = (query or "").strip()
    q = re.sub(r"\bi'm\b", "the user is", q, flags=re.IGNORECASE)
    q = re.sub(r"\bi've\b", "the user has", q, flags=re.IGNORECASE)
    q = re.sub(r"\bi'll\b", "the user will", q, flags=re.IGNORECASE)
    q = re.sub(r"\bi'd\b", "the user would", q, flags=re.IGNORECASE)
    q = re.sub(r"\bam i\b", "is the user", q, flags=re.IGNORECASE)
    q = re.sub(r"\bmy\b", "the user's", q, flags=re.IGNORECASE)
    q = re.sub(r"\bi\b", "the user", q, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", q).strip()


def _top_k() -> int:
    try:
        return max(1, int(_plugin_config().get("top_k", _DEFAULT_TOP_K)))
    except Exception:
        return _DEFAULT_TOP_K


def recall_block(
    user_text: str = "", workspace: str = "", top_k: int | None = None
) -> tuple[str, dict | None]:
    """Turn-start semantic recall.

    Queries the project bank and the global bank (bank scoping is strict
    both ways, so both must be fanned out), merges, dedupes, and formats a
    prompt block. Returns ``(block, stream_event)`` — ``("", None)`` when
    disabled, empty, or on any error.
    """
    try:
        if not is_enabled():
            return "", None
        _ensure_data_dir()

        k = top_k or _top_k()
        # Empty user text (call site had nothing in scope): fall back to
        # single-token generic queries. Multi-word generic queries behave
        # unpredictably under the SDK's FTS fallback; single tokens match
        # in both FTS and embedding modes.
        queries = (
            [_third_person(user_text)]
            if (user_text or "").strip()
            else list(_GENERIC_RECALL_TOKENS)
        )

        banks = {"project": project_bank(workspace), "global": GLOBAL_BANK}
        seen: set[str] = set()
        merged: list[dict] = []
        for query in queries:
            for label, bank in banks.items():
                try:
                    hits = _get_instance(bank).recall(query, top_k=k) or []
                except Exception:
                    hits = []
                for h in hits:
                    content = _display_content(h.get("content", ""))
                    if not content:
                        continue
                    norm = re.sub(r"\s+", " ", content.lower())
                    if norm in seen:
                        continue
                    seen.add(norm)
                    merged.append(
                        {
                            "content": content,
                            "bank": label,
                            "score": float(h.get("score") or 0.0),
                            "importance": float(h.get("importance") or 0.0),
                            "tier": h.get("tier"),
                        }
                    )
        merged.sort(key=lambda m: (m["importance"], m["score"]), reverse=True)
        merged = merged[:k]
        if not merged:
            return "", None

        lines = ["## Semantic memory (Mnemosyne)"]
        lines.extend(f"- ({m['bank']}) {m['content']}" for m in merged)
        block = "\n".join(lines)
        event = {
            "type": "memory_recall",
            "source": "mnemosyne",
            "banks": [banks["project"], banks["global"]],
            "query": queries[0][:160] if len(queries) == 1 else "generic",
            "count": len(merged),
            "items": [
                {
                    "content": m["content"][:200],
                    "bank": m["bank"],
                    "score": round(m["score"], 4),
                    "importance": m["importance"],
                }
                for m in merged
            ],
        }
        return block, event
    except Exception:
        return "", None


# ---------------------------------------------------------------------------
# Retention (turn end)
# ---------------------------------------------------------------------------


def _clean_fact(sentence: str) -> str:
    """Strip leading meta-scaffolding ("remember this: X" -> "X")."""
    s = sentence.strip().strip("\"'").strip()
    low = s.lower()
    for prefix in _STRIP_PREFIXES:
        if low.startswith(prefix):
            s = s[len(prefix):].lstrip(" :,-").strip()
            break
    return s


def _candidate_facts(user_text: str) -> list[tuple[str, str]]:
    """Extract (fact, bank_label) candidates. Listens like a friend.

    Only the USER's words are mined — never the assistant's. An assistant
    echo, summary, or hallucination must not become a stored "fact"
    without the user actually stating it.

    Two signals, in order:
      1. Direct commands ("remember this", "don't forget", "from now on")
         — strongest signal, always honored, bypasses the junk filter.
      2. Everything else — explicit phrasings ("my name is", "always "...)
         and natural durable-fact shapes (people/pets, identity, tastes,
         habits). These go through the junk filter, so questions,
         opinions, and transient states are never stored.
    """
    facts: list[tuple[str, str]] = []
    text = user_text or ""
    if not text.strip():
        return facts
    for chunk in re.split(r"(?<=[.!?])\s+|\n+", text):
        s = chunk.strip()
        if not s or len(s) > _MAX_FACT_CHARS:
            continue
        low = s.lower()
        label: str | None = None
        if any(tr in low for tr in _COMMAND_TRIGGERS):
            label = "global" if any(tr in low for tr in _GLOBAL_TRIGGERS) else "project"
        else:
            if any(tr in low for tr in _RETAIN_TRIGGERS):
                label = "global" if any(tr in low for tr in _GLOBAL_TRIGGERS) else "project"
            else:
                for rx, lab in _RETAIN_RES:
                    if rx.search(s):
                        label = lab
                        break
            if label is None:
                continue
            if any(rx.search(s) for rx in _JUNK_RES):
                continue  # question / opinion / demonstrative — not a fact
        fact = _clean_fact(s)
        if len(fact) < 8:
            continue
        facts.append((fact, label))
        if len(facts) >= _MAX_FACTS_PER_TURN:
            return facts
    return facts


def retain_turn(user_text: str = "", workspace: str = "") -> int:
    """Turn-end conservative retention. Returns the number of facts stored.

    Mines only the user's words (see _candidate_facts) — the assistant's
    reply is deliberately not an input, so assistant wording can never
    mint an unsupported "fact".
    Also fires consolidation opportunistically when due (daemon thread).
    Never raises — retention must not break a turn.
    """
    try:
        if not is_enabled():
            return 0
        facts = _candidate_facts(user_text)
        stored = 0
        if facts:
            _ensure_data_dir()

            banks = {"project": project_bank(workspace), "global": GLOBAL_BANK}
            for fact, label in facts:
                try:
                    bank = banks[label]
                    inst = _get_instance(bank)
                    dupes = inst.recall(fact, top_k=3) or []
                    norm_fact = _norm_content(fact)
                    if any(_norm_content(h.get("content", "")) == norm_fact for h in dupes):
                        continue  # already known — don't stack duplicates
                    if dupes and float(dupes[0].get("score") or 0) > 0.95:
                        continue  # paraphrase of something already stored
                    rid = inst.remember(
                        fact,
                        importance=0.85,
                        source="conversation",
                        metadata={"origin": "yaah-retain"},
                    )
                    if rid:
                        stored += 1
                except Exception:
                    continue
        # Opportunistic consolidation: independent of the scheduler tick.
        try:
            if sleep_due():
                _spawn_sleep(workspace)
        except Exception:
            pass
        return stored
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Consolidation (sleep)
# ---------------------------------------------------------------------------


def _last_sleep_path() -> str:
    return os.path.join(data_dir(), _LAST_SLEEP_FILENAME)


def _sleep_interval_hours() -> float:
    try:
        return max(
            0.25, float(_plugin_config().get("sleep_interval_hours", _DEFAULT_SLEEP_INTERVAL_HOURS))
        )
    except Exception:
        return _DEFAULT_SLEEP_INTERVAL_HOURS


def sleep_due() -> bool:
    """True when consolidation never ran or the interval elapsed."""
    try:
        with open(_last_sleep_path(), encoding="utf-8") as f:
            last = float(json.load(f).get("ts", 0))
    except Exception:
        return True
    return (time.time() - last) >= _sleep_interval_hours() * 3600


def run_sleep(workspace: str = "") -> dict:
    """Consolidate working -> episodic memory for project + global banks.

    Thread-safe (module lock). Writes the last-sleep stamp only when every
    bank consolidated cleanly. Returns a per-bank summary.
    """
    _ensure_data_dir()
    from mnemosyne import Mnemosyne

    banks = [GLOBAL_BANK]
    if workspace:
        banks.insert(0, project_bank(workspace))
    summary: dict = {}
    for bank in banks:
        try:
            # Fresh instance per sleep run (thread affinity for its SQLite
            # connection); construction serialized via _instances_lock
            # (see note above) so it can never race another thread's
            # init_db schema migration on the same database file.
            with _instances_lock:
                inst = Mnemosyne(bank=bank)
            with _sleep_lock:
                result = inst.sleep()
            summary[bank] = {"ok": True, "result": result}
        except Exception as exc:  # noqa: BLE001
            summary[bank] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    if summary and all(v.get("ok") for v in summary.values()):
        try:
            with open(_last_sleep_path(), "w", encoding="utf-8") as f:
                json.dump({"ts": time.time()}, f)
        except Exception:
            pass
    return summary


def _sleep_worker(workspace: str) -> None:
    try:
        run_sleep(workspace)
    except Exception:
        pass


def _spawn_sleep(workspace: str = "") -> None:
    t = threading.Thread(
        target=_sleep_worker, args=(workspace,), daemon=True, name="yaah-mnemosyne-sleep"
    )
    t.start()
