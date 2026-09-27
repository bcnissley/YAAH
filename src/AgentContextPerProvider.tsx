/** Per-provider "Agent & context" editor, shown inside the expanded
 *  provider row on the Providers tab (issue #111). It renders ONE ENTRY PER
 *  CONFIGURED MODEL; each entry owns its model (catalog dropdown), max
 *  steps, and history compaction (toggle + threshold). There is NO
 *  provider-level max steps. The context window is NOT a setting: the
 *  detected value (provider report -> built-in table) shows read-only as
 *  the reference for the context gauge. */

import type React from 'react'
import { useState } from 'react'

/** One configured model's settings + change handlers (owned by the parent). */
export interface ModelEntry {
  model: string
  /** Per-model step budget; '' = untouched (default applies). */
  steps: number | ''
  onSteps: (v: number | '') => void
  compEnabled: boolean
  onCompEnabled: (v: boolean) => void
  /** Compaction trigger draft in k tokens; '' = untouched. */
  compK: number | ''
  onCompK: (v: number | '') => void
  /** Detected (auto-resolved) window for this model, or null. */
  ctxAuto: number | null
}

interface AgentCtxPerProviderProps {
  /** Provider name being edited. */
  name: string
  /** Model catalog for this provider (may be empty when unreachable). */
  models: string[]
  /** One entry per configured model, in display order. */
  entries: ModelEntry[]
  /** Register a model id (dropdown pick or free-typed) as a new entry. */
  onAddModel: (id: string) => void
  /** Remove a model entry from this provider's editor. */
  onRemoveModel?: (id: string) => void
  compactionDefaultK: number
  maxStepsDefault: number
  inputCls: string
}

export function AgentContextPerProvider({
  name,
  models,
  entries,
  onAddModel,
  onRemoveModel,
  compactionDefaultK,
  maxStepsDefault,
  inputCls,
}: AgentCtxPerProviderProps) {
  /** Inline "add model" affordance: dropdown first (catalog), free-type as
   *  the explicit fallback for ids the catalog doesn't list. */
  const [adding, setAdding] = useState(false)
  const [freeType, setFreeType] = useState(false)
  const [newModel, setNewModel] = useState('')
  const submitNewModel = () => {
    const id = newModel.trim()
    if (!id) return
    onAddModel(id)
    setNewModel('')
    setFreeType(false)
    setAdding(false)
  }

  const close = () => {
    setAdding(false)
    setFreeType(false)
    setNewModel('')
  }

  /** Catalog models not already configured as entries. */
  const addable = models.filter((m) => !entries.some((e) => e.model === m))

  return (
    <div className="mt-2.5 border-t border-zinc-800 pt-2.5" data-agent-ctx={name}>
      <h4 className="mb-2 font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-zinc-500">
        Agent &amp; context
      </h4>

      {entries.map((e) => (
        <div
          key={e.model}
          data-model-entry={e.model}
          className="mb-2.5 rounded border border-zinc-800 p-2"
        >
          {/* The entry header IS the model identity: everything below sits
              visually inside this model's scope. */}
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[11px] text-zinc-200">{e.model}</span>
            {onRemoveModel && entries.length > 1 && (
              <button
                type="button"
                className="ml-auto text-[10px] text-zinc-600 hover:text-red-400"
                onClick={() => onRemoveModel(e.model)}
                aria-label={`remove model entry ${e.model}`}
              >
                remove
              </button>
            )}
          </div>

          {/* Per-model max steps (issue #111 comment: per-model ONLY, no
              provider-level field anywhere). */}
          <label className="mb-1 block text-[10px] text-zinc-500">max steps</label>
          <input
            type="number"
            min="0"
            className={`${inputCls} w-full`}
            value={e.steps === '' ? maxStepsDefault : e.steps}
            onChange={(ev) => e.onSteps(ev.target.value === '' ? '' : Number(ev.target.value))}
            aria-label={`max steps for ${e.model}`}
          />
          <p className="mt-0.5 text-[10px] text-zinc-600">
            {maxStepsDefault} by default · 0 = unlimited (Stop still works)
          </p>

          {/* Per-model compaction. The trigger is a plain token value; the
              detected context window below is read-only reference. */}
          <div className="mt-1.5 flex items-center gap-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={e.compEnabled}
              aria-label={`Enable history compaction for ${e.model}`}
              className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${
                e.compEnabled ? 'bg-blue-600' : 'bg-zinc-700'
              }`}
              onClick={() => e.onCompEnabled(!e.compEnabled)}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-zinc-100 transition-all ${
                  e.compEnabled ? 'left-4.5' : 'left-0.5'
                }`}
              />
            </button>
            <span className="text-[10px] text-zinc-400">{e.compEnabled ? 'On' : 'Off'} — fold old history past</span>
            <input
              type="number"
              min="0"
              aria-label={`Compaction trigger for ${e.model}`}
              className={`${inputCls} w-20 shrink-0`}
              value={e.compK}
              onChange={(ev) => e.onCompK(ev.target.value === '' ? '' : Number(ev.target.value))}
            />
            <span className="text-[10px] text-zinc-600">
              k tokens (default {compactionDefaultK}k)
            </span>
          </div>
          <p className="mt-1 font-mono text-[10px] text-zinc-600">
            {e.ctxAuto != null
              ? `context window (detected): ${e.ctxAuto.toLocaleString()} tokens`
              : 'context window: not detected — no % readout for this model'}
          </p>
        </div>
      ))}

      {/* Add another entry: the catalog dropdown first, free-type as an
          explicit fallback for ids the catalog doesn't list. Unlimited
          entries are allowed. */}
      {adding ? (
        freeType ? (
          <span className="mt-1 flex gap-1.5">
            <input
              className={`${inputCls} min-w-0 flex-1`}
              placeholder="model id (e.g. openai/gpt-5.2)"
              value={newModel}
              autoFocus
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitNewModel()
                } else if (e.key === 'Escape') {
                  close()
                }
              }}
              aria-label={`model id to add for ${name}`}
            />
            <button
              type="button"
              className="shrink-0 rounded border border-zinc-700 px-2 text-[11px] text-zinc-300 hover:bg-zinc-800"
              onClick={submitNewModel}
            >
              add
            </button>
            <button
              type="button"
              className="shrink-0 rounded px-1 text-[11px] text-zinc-500 hover:text-zinc-300"
              onClick={close}
              aria-label="Cancel adding a model"
            >
              cancel
            </button>
          </span>
        ) : (
          <span className="mt-1 flex items-center gap-1.5">
            <select
              className={`${inputCls} min-w-0 flex-1`}
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  onAddModel(e.target.value)
                  close()
                }
              }}
              aria-label={`model to add for ${name}`}
            >
              <option value="">{addable.length ? 'choose a model…' : 'no models in catalog'}</option>
              {addable.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="shrink-0 rounded px-1 text-[10px] text-zinc-500 hover:text-zinc-300"
              onClick={() => setFreeType(true)}
              aria-label="type a model id instead"
            >
              type id…
            </button>
            <button
              type="button"
              className="shrink-0 rounded px-1 text-[11px] text-zinc-500 hover:text-zinc-300"
              onClick={close}
              aria-label="Cancel adding a model"
            >
              cancel
            </button>
          </span>
        )
      ) : (
        <button
          type="button"
          className="mt-1 block text-[10px] text-zinc-500 hover:text-zinc-300"
          onClick={() => setAdding(true)}
        >
          + add a model to configure
        </button>
      )}
    </div>
  )
}
