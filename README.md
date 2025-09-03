# src/store/useEditorStore.ts  // UPDATED: add lastSavedSig/lastSavedTs + keep them fresh on save/load/revert
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { EditorState, PresetSlot } from '../types'
import { CURRENT_PROJECT_VERSION } from '../types'
import { migrateProject } from '../utils/migrate'

const STORAGE_KEY = 'face-editor-project-v1'
const PRESETS_KEY = 'face-editor-custom-presets-v1'

const defaultState: EditorState = {
  projectVersion: CURRENT_PROJECT_VERSION,
  imageUrl: null, width: 0, height: 0, faces: [],
  preset: 'Natural', showBefore: false, globalStrength: 0.7, featherPx: 12,
  brushMode: 'add', brushSize: 60, userMask: null,
  smoothing: 'bilateral', bilateralSigmaS: 4, bilateralSigmaR: 0.08,
  qualityMode: 'pyramid', qualityAuto: true, targetFps: 30, downsampleFactor: 3,
  autoParams: { minDownsample: 2, maxDownsample: 4, aggressiveness: 0.55, cooldownMs: 550, allowModeAuto: true, forcePyramidAtMP: 9, minFpsFloor: 22 },
  customPresets: [], blendMode: 'lab',
  hasSnapshot: false, compareActive: false, compareSplit: 0.5,
  snapshotPng: null, snapshotOriginalPng: null,
  embeddedOriginal: null,
  // @ts-ignore
  openSkipDetectIfFaces: true,
}

type Actions = {
  saveProject: () => void
  loadProject: (json: string) => void
  loadProjectJson: (raw: string) => void
  revertToLastSaved: () => boolean
  setOpenSkipDetectIfFaces: (b: boolean) => void
}

export const useEditorStore = create<{ past: EditorState[]; present: EditorState; future: EditorState[] } & Actions & {
  // meta (non-undoable)
  lastSavedSig?: string | null
  lastSavedTs?: number | null
}>()(
  immer((set, get) => ({
    past: [],
    present: { ...defaultState, customPresets: loadCustomPresets() },
    future: [],
    lastSavedSig: null,
    lastSavedTs: null,

    saveProject: () => {
      try {
        const s = get().present
        const serializable = stripVolatile({ ...s, projectVersion: CURRENT_PROJECT_VERSION })
        const json = JSON.stringify(serializable)
        localStorage.setItem(STORAGE_KEY, json)
        set(st => {
          ;(st as any).lastSavedSig = json
          ;(st as any).lastSavedTs = Date.now()
        })
      } catch {}
    },

    loadProject: (json) => {
      try {
        const parsed = migrateProject(json)
        set(state => {
          state.past.push(structuredClone(stripVolatile(state.present)))
          state.present = {
            ...defaultState, ...parsed,
            projectVersion: CURRENT_PROJECT_VERSION,
            userMask: allocMaskCanvas(parsed.width, parsed.height),
            customPresets: loadCustomPresets(),
            embeddedOriginal: null,
            // @ts-ignore
            openSkipDetectIfFaces: state.present.openSkipDetectIfFaces ?? true,
          }
          state.future = []
          const sig = JSON.stringify(stripVolatile(state.present))
          ;(state as any).lastSavedSig = sig
          ;(state as any).lastSavedTs = Date.now()
        })
      } catch (e) { console.error('Failed to load project', e) }
    },

    loadProjectJson: (raw) => {
      try {
        const parsedRaw = JSON.parse(raw)
        const embedded = parsedRaw.snapshotOriginalPng ? String(parsedRaw.snapshotOriginalPng) : null
        const parsed = migrateProject(parsedRaw)
        set(state => {
          state.past.push(structuredClone(stripVolatile(state.present)))
          state.present = {
            ...defaultState, ...parsed,
            projectVersion: CURRENT_PROJECT_VERSION,
            userMask: allocMaskCanvas(parsed.width, parsed.height),
            customPresets: loadCustomPresets(),
            embeddedOriginal: embedded,
            // @ts-ignore
            openSkipDetectIfFaces: state.present.openSkipDetectIfFaces ?? true,
          }
          state.future = []
          const sig = JSON.stringify(stripVolatile(state.present))
          ;(state as any).lastSavedSig = sig
          ;(state as any).lastSavedTs = Date.now()
        })
      } catch (e) { console.error('Failed to open project JSON', e) }
    },

    revertToLastSaved: () => {
      try {
        const json = localStorage.getItem(STORAGE_KEY)
        if (!json) return false
        const parsed = migrateProject(json)
        set(state => {
          state.past.push(structuredClone(stripVolatile(state.present)))
          state.present = {
            ...defaultState, ...parsed,
            projectVersion: CURRENT_PROJECT_VERSION,
            userMask: allocMaskCanvas(parsed.width, parsed.height),
            customPresets: loadCustomPresets(),
            embeddedOriginal: null,
            // @ts-ignore
            openSkipDetectIfFaces: state.present.openSkipDetectIfFaces ?? true,
          }
          state.future = []
          ;(state as any).lastSavedSig = json
          ;(state as any).lastSavedTs = Date.now()
        })
        return true
      } catch (e) { console.error('Failed to revert to last saved', e); return false }
    },

    setOpenSkipDetectIfFaces: (b) => set(s => { (s.present as any).openSkipDetectIfFaces = b }),
  }))
)

function allocMaskCanvas(w: number, h: number): HTMLCanvasElement { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d')!.clearRect(0,0,w,h); return c }
function stripVolatile(s: EditorState) {
  const { userMask, snapshotPng, snapshotOriginalPng, embeddedOriginal, openSkipDetectIfFaces, ...rest } = s as any
  return rest
}
function loadCustomPresets(): PresetSlot[] { try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]') } catch { return [] } }

# src/components/Toolbar.tsx  // UPDATED: conflict guard before opening .json
import { StatusChip } from './StatusChip'
import { useEditorStore } from '../store/useEditorStore'
import { HelpButton } from './Help'
import { saveNow } from '../utils/saver'
import { exportImage, exportPSD } from '../utils/psd'
import { LastSaved } from './LastSaved'
import { showToast } from './ToastHost'
import { CURRENT_PROJECT_VERSION } from '../types'
import { useRef } from 'react'

function tsName(prefix = 'project') {
  const d = new Date(); const pad = (n: number) => String(n).padStart(2,'0')
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`
}

function hasUnsavedChanges(): boolean {
  const st: any = useEditorStore.getState()
  const sigSaved: string | null = st.lastSavedSig ?? null
  const sigNow = JSON.stringify((() => {
    const { userMask, snapshotPng, snapshotOriginalPng, embeddedOriginal, openSkipDetectIfFaces, ...rest } = st.present
    return rest
  })())
  return !!sigSaved && sigNow !== sigSaved
}

export function Toolbar({ getCanvases }: { getCanvases: () => { original: HTMLCanvasElement | null, edited: HTMLCanvasElement | null } }) {
  const { present } = useEditorStore(s=>({ present: s.present }))
  const setQualityAuto = useEditorStore(s=>s.setQualityAuto)
  const restoreAuto = useEditorStore(s=>s.restoreAuto)
  const saveProject = useEditorStore(s=>s.saveProject)
  const revertToLastSaved = useEditorStore(s=>s.revertToLastSaved)
  const loadProjectJson = useEditorStore(s=>s.loadProjectJson)
  const setOpenSkipDetectIfFaces = useEditorStore(s=>s.setOpenSkipDetectIfFaces)

  const fileRef = useRef<HTMLInputElement>(null)

  function runBenchmark() { window.dispatchEvent(new CustomEvent('run-benchmark', { detail: { lock: true } })) }
  function onSaveNow() { saveNow(saveProject, 'manual') }

  function onExportPNG(){ const { edited }=getCanvases(); if(!edited) return; exportImage(edited,'image/png',1,'export'); saveNow(saveProject,'export') }
  function onExportJPG(){ const { edited }=getCanvases(); if(!edited) return; exportImage(edited,'image/jpeg',0.92,'export'); saveNow(saveProject,'export') }
  function onExportPSD(){ const { original, edited }=getCanvases(); if(!original||!edited) return; exportPSD(original,edited,'export.psd'); saveNow(saveProject,'export') }

  function onSaveAs() {
    const { userMask, snapshotPng, snapshotOriginalPng, embeddedOriginal, openSkipDetectIfFaces, ...serializable } = present as any
    const json = JSON.stringify({ ...serializable, projectVersion: CURRENT_PROJECT_VERSION }, null, 2)
    const blob = new Blob([json], { type:'application/json' }); const a=document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = tsName('project'); document.body.appendChild(a); a.click(); URL.revokeObjectURL(a.href); a.remove()
    showToast('Downloaded project snapshot')
  }
  function onSaveAsEmbedded() {
    const { original, edited } = getCanvases()
    if (!edited) { showToast('No edited canvas to embed', 2200); return }
    const editedDataUrl = edited.toDataURL('image/png')
    const originalDataUrl = (original ? original.toDataURL('image/png') : editedDataUrl)
    const { userMask, embeddedOriginal, openSkipDetectIfFaces, ...serializable } = present as any
    const json = JSON.stringify({ ...serializable, projectVersion: CURRENT_PROJECT_VERSION, snapshotPng: editedDataUrl, snapshotOriginalPng: originalDataUrl }, null, 2)
    const blob = new Blob([json], { type:'application/json' }); const a=document.createElement('a')
    a.href = URL.createObjectURL(blob); a.download = tsName('project-embedded'); document.body.appendChild(a); a.click(); URL.revokeObjectURL(a.href); a.remove()
    showToast('Downloaded project + embedded PNGs')
  }

  function onOpenClick() {
    if (hasUnsavedChanges()) {
      const ok = window.confirm('You have unsaved changes. Open will overwrite the current project. Continue?')
      if (!ok) return
    }
    fileRef.current?.click()
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    try {
      const text = await f.text()
      const raw = JSON.parse(text)
      const dataUrl = raw.snapshotOriginalPng as string | undefined
      const imageUrl = raw.imageUrl as string | undefined
      const faces = Array.isArray(raw.faces) ? raw.faces : undefined
      const skipDetect = !!present.openSkipDetectIfFaces
      loadProjectJson(text)
      window.dispatchEvent(new CustomEvent('open-project', { detail: { dataUrl, imageUrl, faces, skipDetect } }))
      showToast('Project opened')
    } catch (err) {
      console.error(err); showToast('Failed to open project', 2500)
    } finally {
      e.target.value = ''
    }
  }

  function onRevert() {
    const ok = window.confirm('Revert to the last saved version? Unsaved changes will be lost.')
    if (!ok) return
    const success = revertToLastSaved()
    showToast(success ? 'Reverted to last saved' : 'No saved project found', success ? 2000 : 2500)
  }

  function onRestoreOriginal() {
    if (!(present as any).embeddedOriginal) { showToast('No embedded original in this project', 2500); return }
    window.dispatchEvent(new CustomEvent('restore-original', { detail: { dataUrl: (present as any).embeddedOriginal } }))
  }

  return (
    <div style={{display:'flex', gap:8, alignItems:'center', padding:8, borderBottom:'1px solid #ddd', flexWrap:'wrap'}}>
      <button onClick={onOpenClick} title="Open Project (.json)">Open Project…</button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFileChange} />
      <label style={{display:'inline-flex', alignItems:'center', gap:6}}>
        <input type="checkbox" checked={(present as any).openSkipDetectIfFaces ?? true} onChange={e=>setOpenSkipDetectIfFaces(e.target.checked)} />
        Skip face re-detect if faces exist
      </label>

      <button onClick={onSaveNow} title="Save now (Cmd/Ctrl+S)">Save now</button>
      <button onClick={onRevert} title="Reload last saved from this device">Revert to last saved</button>
      <button onClick={onRestoreOriginal} disabled={!(present as any).embeddedOriginal} title="Restore original image from embedded snapshot">Restore original image</button>

      <LastSaved />

      <StatusChip />
      <button onClick={runBenchmark} title="(B) Lock best settings">Benchmark & Lock</button>
      <label style={{display:'inline-flex', alignItems:'center', gap:6}}>
        <input type="checkbox" checked={present.qualityAuto} onChange={e=>setQualityAuto(e.target.checked)} />
        Auto Quality
      </label>
      <button onClick={restoreAuto} title="Restore previous Auto">Restore Auto</button>

      <div style={{marginLeft:'auto', display:'flex', gap:8}}>
        <button onClick={onExportPNG}>Export PNG</button>
        <button onClick={onExportJPG}>Export JPG</button>
        <button onClick={onExportPSD}>Export PSD</button>
        <button onClick={onSaveAs} title="Download project JSON">Save As…</button>
        <button onClick={onSaveAsEmbedded} title="Download JSON with embedded edited+original PNGs">Save As (embedded PNGs)</button>
        <HelpButton />
      </div>
    </div>
  )
}

# src/components/DragDropProject.tsx  // UPDATED: conflict guard on drop
import { useEffect } from 'react'
import { useEditorStore } from '../store/useEditorStore'
import { showToast } from './ToastHost'

function hasUnsavedChanges(): boolean {
  const st: any = useEditorStore.getState()
  const sigSaved: string | null = st.lastSavedSig ?? null
  const sigNow = JSON.stringify((() => {
    const { userMask, snapshotPng, snapshotOriginalPng, embeddedOriginal, openSkipDetectIfFaces, ...rest } = st.present
    return rest
  })())
  return !!sigSaved && sigNow !== sigSaved
}

export function DragDropProject() {
  const loadProjectJson = useEditorStore(s=>s.loadProjectJson)
  const getSkip = () => (useEditorStore.getState().present as any).openSkipDetectIfFaces ?? true

  useEffect(() => {
    const onDragOver = (e: DragEvent) => { if (e.dataTransfer) e.preventDefault() }
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer) return
      e.preventDefault()
      const f = Array.from(e.dataTransfer.files).find(f=>f.type==='application/json' || f.name.endsWith('.json'))
      if (!f) return
      if (hasUnsavedChanges()) {
        const ok = window.confirm('You have unsaved changes. Opening will overwrite the current project. Continue?')
        if (!ok) return
      }
      try {
        const text = await f.text()
        const raw = JSON.parse(text)
        const dataUrl = raw.snapshotOriginalPng as string | undefined
        const imageUrl = raw.imageUrl as string | undefined
        const faces = Array.isArray(raw.faces) ? raw.faces : undefined
        const skipDetect = getSkip()
        loadProjectJson(text)
        window.dispatchEvent(new CustomEvent('open-project', { detail: { dataUrl, imageUrl, faces, skipDetect } }))
        showToast('Project opened (drop)')
      } catch (err) {
        console.error(err); showToast('Failed to open project', 2500)
      }
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [loadProjectJson])

  return null
}

