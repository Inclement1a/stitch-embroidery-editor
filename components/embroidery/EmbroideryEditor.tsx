"use client";

import {
  Brush,
  Check,
  Cloud,
  CloudDownload,
  CloudUpload,
  Download,
  Eye,
  EyeOff,
  FileJson,
  Grid3X3,
  Hand,
  Map as MapIcon,
  Maximize2,
  Minus,
  PaintBucket,
  Palette,
  Pipette,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  Settings2,
  Sparkles,
  SquareDashedMousePointer,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Script from "next/script";
import type {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import patternJson from "@/lib/embroidery/pattern.json";
import {
  downloadCloudProject,
  findCloudProject,
  GOOGLE_DRIVE_SCOPE,
  GoogleDriveError,
  uploadCloudProject,
} from "@/lib/embroidery/googleDrive";

import styles from "./EmbroideryEditor.module.css";

type SymbolKey = string;
type Tool = "pan" | "brush" | "area" | "fill" | "picker";
type ViewMode = "edit" | "stitch";

type PaletteItem = {
  symbol: SymbolKey;
  dmc: string;
  name: string;
  color: string;
  textColor: string;
  count: number;
};

type PatternData = {
  title: string;
  width: number;
  height: number;
  sectorSize: number;
  palette: PaletteItem[];
  rows: string[];
};

type Change = { indices: number[]; before: number[]; after: number[] };
type EditorView = { scale: number; offsetX: number; offsetY: number };
type CellPoint = { col: number; row: number };
type AreaSelection = { start: CellPoint; end: CellPoint };
type ImportedProject = {
  width?: number;
  height?: number;
  rows?: unknown;
  palette?: Array<{
    symbol?: string;
    color?: string;
    dmc?: string;
    name?: string;
    textColor?: string;
  }>;
  completed?: unknown;
};
type RestoredProject = {
  filename: string;
  cells: Uint8Array;
  done: Uint8Array;
  palette: PaletteItem[];
  source: "file" | "cloud";
};

type GoogleTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type GoogleTokenClient = {
  requestAccessToken: (config?: { prompt?: string }) => void;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: GoogleTokenResponse) => void;
            error_callback?: (error: { type?: string }) => void;
          }) => GoogleTokenClient;
          revoke: (token: string, callback?: () => void) => void;
        };
      };
    };
  }
}

const pattern = patternJson as PatternData;
const initialSymbols = pattern.palette.map((item) => item.symbol);
const initialSymbolToIndex = new Map(
  initialSymbols.map((symbol, index) => [symbol, index]),
);
const paletteSymbolPool =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const storageKey = "stitch-studio-project-v6";
const googleClientIdStorageKey = "stitch-studio-google-client-id";
const defaultGoogleClientId =
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ??
  "111374758065-3mponeoaib8mnqdo8qfba0t8nffo19om.apps.googleusercontent.com";

function buildInitialCells() {
  return Uint8Array.from(
    pattern.rows.join(""),
    (symbol) => initialSymbolToIndex.get(symbol as SymbolKey) ?? 0,
  );
}

function encodeCells(cells: Uint8Array, palette: PaletteItem[]) {
  let value = "";
  for (const cell of cells) value += palette[cell]?.symbol ?? palette[0].symbol;
  return value;
}

function getTextColor(color: string) {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1000;
  return luminance > 150 ? "#17312F" : "#FFFFFF";
}

function buildPalette(savedPalette?: ImportedProject["palette"]) {
  const savedBySymbol = new Map(
    (savedPalette ?? [])
      .filter(
        (item) =>
          typeof item.symbol === "string" &&
          item.symbol.length === 1 &&
          typeof item.color === "string" &&
          /^#[0-9a-f]{6}$/i.test(item.color),
      )
      .map((item) => [item.symbol as string, item]),
  );

  const nextPalette = pattern.palette.map((item) => {
    const saved = savedBySymbol.get(item.symbol);
    if (!saved?.color) return { ...item };
    const color = saved.color.toUpperCase();
    return {
      ...item,
      color,
      textColor:
        saved.textColor && /^#[0-9a-f]{6}$/i.test(saved.textColor)
          ? saved.textColor.toUpperCase()
          : getTextColor(color),
    };
  });

  for (const saved of savedPalette ?? []) {
    if (
      typeof saved.symbol !== "string" ||
      saved.symbol.length !== 1 ||
      initialSymbolToIndex.has(saved.symbol) ||
      nextPalette.some((item) => item.symbol === saved.symbol) ||
      typeof saved.color !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(saved.color)
    ) {
      continue;
    }
    const color = saved.color.toUpperCase();
    nextPalette.push({
      symbol: saved.symbol,
      dmc: typeof saved.dmc === "string" ? saved.dmc.slice(0, 18) : "",
      name:
        typeof saved.name === "string" && saved.name.trim()
          ? saved.name.trim().slice(0, 40)
          : "Свой цвет",
      color,
      textColor:
        saved.textColor && /^#[0-9a-f]{6}$/i.test(saved.textColor)
          ? saved.textColor.toUpperCase()
          : getTextColor(color),
      count: 0,
    });
  }

  return nextPalette.slice(0, 255);
}

function getPaletteLabel(item: PaletteItem) {
  return item.dmc ? `DMC ${item.dmc}` : "Свой цвет";
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function getFitScale(width: number, height: number) {
  if (!width || !height) return 1;
  return Math.max(
    0.25,
    Math.min((width - 34) / pattern.width, (height - 34) / pattern.height),
  );
}

function constrainView(view: EditorView, width: number, height: number): EditorView {
  if (!width || !height) return view;
  const contentWidth = pattern.width * view.scale;
  const contentHeight = pattern.height * view.scale;
  const edge = 18;
  const offsetX =
    contentWidth <= width - edge * 2
      ? (width - contentWidth) / 2
      : Math.max(width - contentWidth - edge, Math.min(edge, view.offsetX));
  const offsetY =
    contentHeight <= height - edge * 2
      ? (height - contentHeight) / 2
      : Math.max(height - contentHeight - edge, Math.min(edge, view.offsetY));
  return { ...view, offsetX, offsetY };
}

function restoreImportedProject(
  imported: ImportedProject,
  filename: string,
  source: RestoredProject["source"],
): RestoredProject {
  if (imported.width !== pattern.width || imported.height !== pattern.height) {
    throw new Error(
      `Ожидается схема ${pattern.width} × ${pattern.height} крестиков.`,
    );
  }
  if (
    !Array.isArray(imported.rows) ||
    imported.rows.length !== pattern.height ||
    imported.rows.some(
      (row) => typeof row !== "string" || row.length !== pattern.width,
    )
  ) {
    throw new Error("В файле повреждены или отсутствуют строки схемы.");
  }

  const encoded = (imported.rows as string[]).join("");
  const nextPalette = buildPalette(imported.palette);
  const symbolToIndex = new Map(
    nextPalette.map((item, index) => [item.symbol, index]),
  );
  if ([...encoded].some((symbol) => !symbolToIndex.has(symbol))) {
    throw new Error("В схеме есть неизвестные обозначения цветов.");
  }

  if (
    imported.completed !== undefined &&
    (!Array.isArray(imported.completed) ||
      imported.completed.some(
        (index) =>
          !Number.isInteger(index) ||
          index < 0 ||
          index >= pattern.width * pattern.height,
      ))
  ) {
    throw new Error("Список выполненных крестиков повреждён.");
  }

  const nextCells = Uint8Array.from(
    encoded,
    (symbol) => symbolToIndex.get(symbol) ?? 0,
  );
  const nextDone = new Uint8Array(pattern.width * pattern.height);
  if (Array.isArray(imported.completed)) {
    imported.completed.forEach((index) => {
      nextDone[index as number] = 1;
    });
  }
  return {
    filename,
    cells: nextCells,
    done: nextDone,
    palette: nextPalette,
    source,
  };
}

export default function EmbroideryEditor() {
  const undoStack = useRef<Change[]>([]);
  const redoStack = useRef<Change[]>([]);
  const painting = useRef(false);
  const paintedInStroke = useRef(new Set<number>());
  const areaSelectionRef = useRef<AreaSelection | null>(null);
  const panStart = useRef<{
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const overviewCanvas = useRef<HTMLCanvasElement>(null);
  const editorCanvas = useRef<HTMLCanvasElement>(null);
  const editorViewport = useRef<HTMLDivElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const viewInitialized = useRef(false);
  const accessToken = useRef<string | null>(null);
  const cloudSaveTimer = useRef<number | null>(null);
  const lastCloudSnapshot = useRef<string | null>(null);

  const [cells, setCells] = useState<Uint8Array>(() => buildInitialCells());
  const [done, setDone] = useState<Uint8Array>(
    () => new Uint8Array(pattern.width * pattern.height),
  );
  const cellsRef = useRef(cells);
  const doneRef = useRef(done);
  const [palette, setPalette] = useState<PaletteItem[]>(() =>
    pattern.palette.map((item) => ({ ...item })),
  );
  const [addColorDialogOpen, setAddColorDialogOpen] = useState(false);
  const [newColorName, setNewColorName] = useState("Свой цвет");
  const [newColorDmc, setNewColorDmc] = useState("");
  const [newColorValue, setNewColorValue] = useState("#4B1D68");
  const [selectedSymbol, setSelectedSymbol] = useState(1);
  const selectedSymbolRef = useRef(selectedSymbol);
  const [tool, setTool] = useState<Tool>("pan");
  const [viewMode, setViewMode] = useState<ViewMode>("edit");
  const [visibleSymbols, setVisibleSymbols] = useState<Set<number>>(
    () => new Set(pattern.palette.map((_, index) => index)),
  );
  const [historyCounts, setHistoryCounts] = useState({ undo: 0, redo: 0 });
  const [hydrated, setHydrated] = useState(false);
  const [saveLabel, setSaveLabel] = useState("Сохранено локально");
  const [mapZoom, setMapZoom] = useState(1);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [editorView, setEditorView] = useState<EditorView>({
    scale: 2,
    offsetX: 0,
    offsetY: 0,
  });
  const [isPanning, setIsPanning] = useState(false);
  const [areaSelection, setAreaSelection] = useState<AreaSelection | null>(null);
  const [pendingImport, setPendingImport] = useState<RestoredProject | null>(null);
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false);
  const [googleScriptReady, setGoogleScriptReady] = useState(false);
  const [googleClientId, setGoogleClientId] = useState(defaultGoogleClientId);
  const [googleClientIdDraft, setGoogleClientIdDraft] = useState(
    defaultGoogleClientId,
  );
  const [cloudConnected, setCloudConnected] = useState(false);
  const [cloudAutoSave, setCloudAutoSave] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudStatus, setCloudStatus] = useState(
    defaultGoogleClientId ? "Готов к подключению" : "Нужна настройка Google",
  );
  const [cloudLastSaved, setCloudLastSaved] = useState<string | null>(null);

  const fitScale = getFitScale(canvasSize.width, canvasSize.height);
  const zoomPercent = Math.round((editorView.scale / fitScale) * 100);

  const selectSymbol = useCallback((index: number) => {
    selectedSymbolRef.current = index;
    setSelectedSymbol(index);
  }, []);

  useEffect(() => {
    if (defaultGoogleClientId) return;
    const savedClientId = window.localStorage.getItem(googleClientIdStorageKey);
    if (!savedClientId) return;
    setGoogleClientId(savedClientId);
    setGoogleClientIdDraft(savedClientId);
    setCloudStatus("Готов к подключению");
  }, []);

  const requestGoogleAccessToken = useCallback(
    (selectAccount = false) =>
      new Promise<string>((resolve, reject) => {
        if (!googleClientId) {
          reject(new Error("Сначала укажите OAuth Client ID приложения Google."));
          return;
        }
        if (!googleScriptReady || !window.google) {
          reject(new Error("Сервис Google ещё загружается. Попробуйте ещё раз."));
          return;
        }

        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: googleClientId,
          scope: GOOGLE_DRIVE_SCOPE,
          callback: (response) => {
            if (!response.access_token) {
              reject(
                new Error(
                  response.error_description ||
                    response.error ||
                    "Google не выдал доступ к облаку.",
                ),
              );
              return;
            }
            accessToken.current = response.access_token;
            setCloudConnected(true);
            setCloudStatus("Google Drive подключён");
            resolve(response.access_token);
          },
          error_callback: (error) => {
            reject(
              new Error(
                error.type === "popup_closed"
                  ? "Окно входа Google было закрыто."
                  : "Не удалось открыть вход Google.",
              ),
            );
          },
        });

        client.requestAccessToken({ prompt: selectAccount ? "select_account" : "" });
      }),
    [googleClientId, googleScriptReady],
  );

  const saveGoogleClientId = () => {
    const value = googleClientIdDraft.trim();
    if (!/^[\w-]+\.apps\.googleusercontent\.com$/i.test(value)) {
      setCloudStatus("Проверьте OAuth Client ID");
      return;
    }
    window.localStorage.setItem(googleClientIdStorageKey, value);
    accessToken.current = null;
    setGoogleClientId(value);
    setCloudConnected(false);
    setCloudAutoSave(false);
    setCloudStatus("Настройка сохранена — подключите Google Drive");
  };

  const commit = useCallback((indices: number[], after: number[]) => {
    const current = cellsRef.current;
    const next = current.slice();
    const actualIndices: number[] = [];
    const before: number[] = [];
    const actualAfter: number[] = [];

    indices.forEach((index, position) => {
      const value = after[position];
      if (current[index] === value) return;
      actualIndices.push(index);
      before.push(current[index]);
      actualAfter.push(value);
      next[index] = value;
    });

    if (actualIndices.length === 0) return;
    cellsRef.current = next;
    setCells(next);
    undoStack.current.push({ indices: actualIndices, before, after: actualAfter });
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
    setHistoryCounts({ undo: undoStack.current.length, redo: 0 });
    setSaveLabel("Сохраняю…");
  }, []);

  const undo = useCallback(() => {
    const change = undoStack.current.pop();
    if (!change) return;
    const next = cellsRef.current.slice();
    change.indices.forEach((index, position) => {
      next[index] = change.before[position];
    });
    cellsRef.current = next;
    setCells(next);
    redoStack.current.push(change);
    setHistoryCounts({ undo: undoStack.current.length, redo: redoStack.current.length });
    setSaveLabel("Сохраняю…");
  }, []);

  const redo = useCallback(() => {
    const change = redoStack.current.pop();
    if (!change) return;
    const next = cellsRef.current.slice();
    change.indices.forEach((index, position) => {
      next[index] = change.after[position];
    });
    cellsRef.current = next;
    setCells(next);
    undoStack.current.push(change);
    setHistoryCounts({ undo: undoStack.current.length, redo: redoStack.current.length });
    setSaveLabel("Сохраняю…");
  }, []);

  const fillRegion = useCallback(
    (startIndex: number) => {
      const currentCells = cellsRef.current;
      const source = currentCells[startIndex];
      const targetSymbol = selectedSymbolRef.current;
      if (source === targetSymbol) return;
      const seen = new Uint8Array(currentCells.length);
      const queue = new Int32Array(currentCells.length);
      const indices: number[] = [];
      let head = 0;
      let tail = 0;
      queue[tail++] = startIndex;
      seen[startIndex] = 1;

      while (head < tail) {
        const index = queue[head++];
        if (currentCells[index] !== source) continue;
        indices.push(index);
        const col = index % pattern.width;
        const neighbors = [index - pattern.width, index + pattern.width];
        if (col > 0) neighbors.push(index - 1);
        if (col < pattern.width - 1) neighbors.push(index + 1);
        neighbors.forEach((neighbor) => {
          if (neighbor < 0 || neighbor >= currentCells.length || seen[neighbor]) return;
          seen[neighbor] = 1;
          if (currentCells[neighbor] === source) queue[tail++] = neighbor;
        });
      }
      commit(indices, indices.map(() => targetSymbol));
    },
    [commit],
  );

  const editCell = useCallback(
    (index: number) => {
      if (viewMode === "stitch") {
        const next = doneRef.current.slice();
        next[index] = next[index] ? 0 : 1;
        doneRef.current = next;
        setDone(next);
        setSaveLabel("Сохраняю…");
        return;
      }
      if (tool === "picker") {
        selectSymbol(cellsRef.current[index]);
        setTool("brush");
      } else if (tool === "fill") {
        fillRegion(index);
      } else {
        commit([index], [selectedSymbolRef.current]);
      }
    },
    [commit, fillRegion, selectSymbol, tool, viewMode],
  );

  const applyAreaSelection = useCallback(
    (selection: AreaSelection) => {
      const left = Math.min(selection.start.col, selection.end.col);
      const right = Math.max(selection.start.col, selection.end.col);
      const top = Math.min(selection.start.row, selection.end.row);
      const bottom = Math.max(selection.start.row, selection.end.row);
      const indices: number[] = [];

      for (let row = top; row <= bottom; row += 1) {
        for (let col = left; col <= right; col += 1) {
          indices.push(row * pattern.width + col);
        }
      }

      if (viewMode === "edit") {
        commit(indices, indices.map(() => selectedSymbolRef.current));
        return;
      }

      const next = doneRef.current.slice();
      const shouldMarkDone = indices.some((index) => !next[index]);
      indices.forEach((index) => {
        next[index] = shouldMarkDone ? 1 : 0;
      });
      doneRef.current = next;
      setDone(next);
      setSaveLabel("Сохраняю…");
    },
    [commit, viewMode],
  );

  const fitEditor = useCallback(() => {
    if (!canvasSize.width || !canvasSize.height) return;
    const scale = getFitScale(canvasSize.width, canvasSize.height);
    setEditorView({
      scale,
      offsetX: (canvasSize.width - pattern.width * scale) / 2,
      offsetY: (canvasSize.height - pattern.height * scale) / 2,
    });
    viewInitialized.current = true;
  }, [canvasSize]);

  const zoomAt = useCallback(
    (factor: number, x = canvasSize.width / 2, y = canvasSize.height / 2) => {
      if (!canvasSize.width || !canvasSize.height) return;
      setEditorView((current) => {
        const minimum = getFitScale(canvasSize.width, canvasSize.height) * 0.75;
        const maximum = Math.max(28, minimum * 10);
        const scale = Math.max(minimum, Math.min(maximum, current.scale * factor));
        const ratio = scale / current.scale;
        return constrainView(
          {
            scale,
            offsetX: x - (x - current.offsetX) * ratio,
            offsetY: y - (y - current.offsetY) * ratio,
          },
          canvasSize.width,
          canvasSize.height,
        );
      });
    },
    [canvasSize],
  );

  const centerEditorOn = useCallback(
    (col: number, row: number) => {
      if (!canvasSize.width || !canvasSize.height) return;
      setEditorView((current) => {
        const scale = Math.min(28, Math.max(current.scale, fitScale * 2.75));
        return constrainView(
          {
            scale,
            offsetX: canvasSize.width / 2 - (col + 0.5) * scale,
            offsetY: canvasSize.height / 2 - (row + 0.5) * scale,
          },
          canvasSize.width,
          canvasSize.height,
        );
      });
    },
    [canvasSize, fitScale],
  );

  useEffect(() => {
    const host = editorViewport.current;
    if (!host) return;
    const updateSize = () => {
      const rect = host.getBoundingClientRect();
      const nextSize = {
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
      setCanvasSize(nextSize);
      if (!viewInitialized.current) {
        const scale = getFitScale(nextSize.width, nextSize.height);
        setEditorView({
          scale,
          offsetX: (nextSize.width - pattern.width * scale) / 2,
          offsetY: (nextSize.height - pattern.height * scale) / 2,
        });
        viewInitialized.current = true;
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stopInteraction = () => {
      painting.current = false;
      paintedInStroke.current.clear();
      panStart.current = null;
      areaSelectionRef.current = null;
      setAreaSelection(null);
      setIsPanning(false);
    };
    window.addEventListener("pointerup", stopInteraction);
    window.addEventListener("pointercancel", stopInteraction);
    return () => {
      window.removeEventListener("pointerup", stopInteraction);
      window.removeEventListener("pointercancel", stopInteraction);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return;
        const saved = JSON.parse(raw) as {
          cells?: string;
          done?: string;
          palette?: string[] | ImportedProject["palette"];
        };
        let restoredPalette = pattern.palette.map((item) => ({ ...item }));
        if (
          Array.isArray(saved.palette) &&
          saved.palette.length === pattern.palette.length &&
          saved.palette.every((color) => typeof color === "string")
        ) {
          restoredPalette = restoredPalette.map((item, index) => {
            const color = (saved.palette as string[])[index];
            return /^#[0-9a-f]{6}$/i.test(color)
              ? {
                  ...item,
                  color: color.toUpperCase(),
                  textColor: getTextColor(color),
                }
              : item;
          });
        } else if (Array.isArray(saved.palette)) {
          restoredPalette = buildPalette(
            saved.palette as ImportedProject["palette"],
          );
        }
        if (saved.cells?.length === pattern.width * pattern.height) {
          const savedSymbolToIndex = new Map(
            restoredPalette.map((item, index) => [item.symbol, index]),
          );
          const restoredCells = Uint8Array.from(
            saved.cells,
            (symbol) => savedSymbolToIndex.get(symbol) ?? 0,
          );
          cellsRef.current = restoredCells;
          setCells(restoredCells);
        }
        if (saved.done?.length === pattern.width * pattern.height) {
          const restoredDone = Uint8Array.from(saved.done, (value) =>
            value === "1" ? 1 : 0,
          );
          doneRef.current = restoredDone;
          setDone(restoredDone);
        }
        setPalette(restoredPalette);
        setVisibleSymbols(
          new Set(restoredPalette.map((_, index) => index)),
        );
      } catch {
        window.localStorage.removeItem(storageKey);
      } finally {
        setHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 2,
          cells: encodeCells(cells, palette),
          done: Array.from(done).join(""),
          palette,
        }),
      );
      setSaveLabel("Сохранено локально");
    }, 280);
    return () => window.clearTimeout(timer);
  }, [cells, done, hydrated, palette]);

  const counts = useMemo(() => {
    const result = new Array(palette.length).fill(0) as number[];
    for (const cell of cells) result[cell] += 1;
    return result;
  }, [cells, palette.length]);

  const completed = useMemo(() => {
    let value = 0;
    for (const cellDone of done) value += cellDone;
    return value;
  }, [done]);

  const serializeProject = useCallback(() => {
    const encoded = encodeCells(cellsRef.current, palette);
    const rows = Array.from({ length: pattern.height }, (_, row) =>
      encoded.slice(row * pattern.width, (row + 1) * pattern.width),
    );
    return JSON.stringify(
      {
        version: 2,
        title: pattern.title,
        width: pattern.width,
        height: pattern.height,
        sectorSize: pattern.sectorSize,
        palette: palette.map((item, index) => ({ ...item, count: counts[index] })),
        rows,
        completed: Array.from(doneRef.current, (value, index) =>
          value ? index : -1,
        ).filter((index) => index >= 0),
      },
      null,
      2,
    );
  }, [counts, palette]);

  const handleCloudError = useCallback((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Неизвестная ошибка Google Drive.";
    if (error instanceof GoogleDriveError && error.status === 401) {
      accessToken.current = null;
      setCloudConnected(false);
      setCloudAutoSave(false);
      setCloudStatus("Сеанс Google истёк — подключитесь снова");
      return;
    }
    setCloudStatus(message);
  }, []);

  const connectGoogleDrive = useCallback(async () => {
    setCloudBusy(true);
    setCloudStatus("Подключаем Google Drive…");
    try {
      const token = await requestGoogleAccessToken(true);
      const cloudFile = await findCloudProject(token);
      setCloudStatus(
        cloudFile
          ? "Подключено — в облаке найдена сохранённая схема"
          : "Подключено — облачная копия ещё не создана",
      );
    } catch (error) {
      handleCloudError(error);
    } finally {
      setCloudBusy(false);
    }
  }, [handleCloudError, requestGoogleAccessToken]);

  const saveToGoogleDrive = useCallback(
    async (interactive = true) => {
      const snapshot = serializeProject();
      if (!interactive && snapshot === lastCloudSnapshot.current) return;
      setCloudBusy(true);
      setCloudStatus("Сохраняем в Google Drive…");
      try {
        const token =
          accessToken.current ??
          (interactive ? await requestGoogleAccessToken(true) : null);
        if (!token) return;
        const saved = await uploadCloudProject(token, snapshot);
        lastCloudSnapshot.current = snapshot;
        setCloudConnected(true);
        setCloudAutoSave(true);
        setCloudLastSaved(
          new Date(saved.modifiedTime ?? Date.now()).toLocaleString("ru-RU", {
            dateStyle: "short",
            timeStyle: "short",
          }),
        );
        setCloudStatus("Сохранено в Google Drive · автосинхронизация включена");
        setSaveLabel("Сохранено локально и в Drive");
      } catch (error) {
        handleCloudError(error);
      } finally {
        setCloudBusy(false);
      }
    },
    [handleCloudError, requestGoogleAccessToken, serializeProject],
  );

  const loadFromGoogleDrive = useCallback(async () => {
    setCloudBusy(true);
    setCloudStatus("Загружаем облачную копию…");
    try {
      const token =
        accessToken.current ?? (await requestGoogleAccessToken(true));
      const cloudFile = await findCloudProject(token);
      if (!cloudFile) {
        setCloudStatus("В Google Drive пока нет сохранённой схемы");
        return;
      }
      const json = await downloadCloudProject(token, cloudFile.id);
      const restored = restoreImportedProject(
        JSON.parse(json) as ImportedProject,
        `Google Drive · ${new Date(cloudFile.modifiedTime ?? Date.now()).toLocaleString("ru-RU")}`,
        "cloud",
      );
      lastCloudSnapshot.current = json;
      setPendingImport(restored);
      setCloudStatus("Облачная копия готова к загрузке");
      setCloudDialogOpen(false);
    } catch (error) {
      handleCloudError(error);
    } finally {
      setCloudBusy(false);
    }
  }, [handleCloudError, requestGoogleAccessToken]);

  const disconnectGoogleDrive = () => {
    const token = accessToken.current;
    if (token && window.google) {
      window.google.accounts.oauth2.revoke(token);
    }
    accessToken.current = null;
    lastCloudSnapshot.current = null;
    setCloudConnected(false);
    setCloudAutoSave(false);
    setCloudLastSaved(null);
    setCloudStatus("Google Drive отключён");
  };

  useEffect(() => {
    if (!hydrated || !cloudConnected || !cloudAutoSave || !accessToken.current) {
      return;
    }
    const snapshot = serializeProject();
    if (snapshot === lastCloudSnapshot.current) return;
    setCloudStatus("Есть изменения — скоро сохраним в Drive");
    if (cloudSaveTimer.current) window.clearTimeout(cloudSaveTimer.current);
    cloudSaveTimer.current = window.setTimeout(() => {
      void saveToGoogleDrive(false);
    }, 1600);
    return () => {
      if (cloudSaveTimer.current) window.clearTimeout(cloudSaveTimer.current);
    };
  }, [
    cells,
    cloudAutoSave,
    cloudConnected,
    done,
    hydrated,
    palette,
    saveToGoogleDrive,
    serializeProject,
  ]);

  const visibleRange = useMemo(() => {
    if (!canvasSize.width || !canvasSize.height) {
      return { left: 1, right: pattern.width, top: 1, bottom: pattern.height };
    }
    return {
      left: Math.max(0, Math.floor(-editorView.offsetX / editorView.scale)) + 1,
      right: Math.min(
        pattern.width,
        Math.ceil((canvasSize.width - editorView.offsetX) / editorView.scale),
      ),
      top: Math.max(0, Math.floor(-editorView.offsetY / editorView.scale)) + 1,
      bottom: Math.min(
        pattern.height,
        Math.ceil((canvasSize.height - editorView.offsetY) / editorView.scale),
      ),
    };
  }, [canvasSize, editorView]);

  useEffect(() => {
    const canvas = editorCanvas.current;
    if (!canvas || !canvasSize.width || !canvasSize.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvasSize.width * dpr);
    canvas.height = Math.round(canvasSize.height * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, canvasSize.width, canvasSize.height);
    context.fillStyle = "#F4F0E9";
    context.fillRect(0, 0, canvasSize.width, canvasSize.height);

    const { scale, offsetX, offsetY } = editorView;
    const startCol = Math.max(0, Math.floor(-offsetX / scale));
    const endCol = Math.min(pattern.width, Math.ceil((canvasSize.width - offsetX) / scale));
    const startRow = Math.max(0, Math.floor(-offsetY / scale));
    const endRow = Math.min(pattern.height, Math.ceil((canvasSize.height - offsetY) / scale));

    context.fillStyle = "#FFFDF9";
    context.fillRect(offsetX, offsetY, pattern.width * scale, pattern.height * scale);

    for (let row = startRow; row < endRow; row += 1) {
      for (let col = startCol; col < endCol; col += 1) {
        const index = row * pattern.width + col;
        const symbolIndex = cells[index];
        const x = offsetX + col * scale;
        const y = offsetY + row * scale;
        context.fillStyle = visibleSymbols.has(symbolIndex)
          ? palette[symbolIndex].color
          : "#EAE5DD";
        context.fillRect(x, y, Math.ceil(scale + 0.4), Math.ceil(scale + 0.4));

        if (viewMode === "stitch" && done[index]) {
          context.fillStyle = "rgba(255,255,255,.64)";
          context.fillRect(x, y, scale, scale);
          if (scale >= 11) {
            context.strokeStyle = "#173533";
            context.lineWidth = Math.max(1.5, scale * 0.1);
            context.beginPath();
            context.moveTo(x + scale * 0.25, y + scale * 0.52);
            context.lineTo(x + scale * 0.43, y + scale * 0.7);
            context.lineTo(x + scale * 0.77, y + scale * 0.3);
            context.stroke();
          }
        }

        if (scale >= 12 && visibleSymbols.has(symbolIndex)) {
          context.fillStyle = palette[symbolIndex].textColor;
          context.font = `800 ${Math.max(8, scale * 0.55)}px sans-serif`;
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText(palette[symbolIndex].symbol, x + scale / 2, y + scale / 2);
        }
      }
    }

    if (scale >= 5) {
      context.strokeStyle = "rgba(23,53,51,.19)";
      context.lineWidth = 1;
      context.beginPath();
      for (let col = startCol; col <= endCol; col += 1) {
        const x = Math.round(offsetX + col * scale) + 0.5;
        context.moveTo(x, offsetY + startRow * scale);
        context.lineTo(x, offsetY + endRow * scale);
      }
      for (let row = startRow; row <= endRow; row += 1) {
        const y = Math.round(offsetY + row * scale) + 0.5;
        context.moveTo(offsetX + startCol * scale, y);
        context.lineTo(offsetX + endCol * scale, y);
      }
      context.stroke();
    }

    context.strokeStyle = "rgba(23,53,51,.68)";
    context.lineWidth = scale >= 7 ? 1.6 : 1;
    context.beginPath();
    for (
      let col = Math.ceil(startCol / pattern.sectorSize) * pattern.sectorSize;
      col <= endCol;
      col += pattern.sectorSize
    ) {
      const x = Math.round(offsetX + col * scale) + 0.5;
      context.moveTo(x, offsetY + startRow * scale);
      context.lineTo(x, offsetY + endRow * scale);
    }
    for (
      let row = Math.ceil(startRow / pattern.sectorSize) * pattern.sectorSize;
      row <= endRow;
      row += pattern.sectorSize
    ) {
      const y = Math.round(offsetY + row * scale) + 0.5;
      context.moveTo(offsetX + startCol * scale, y);
      context.lineTo(offsetX + endCol * scale, y);
    }
    context.stroke();

    if (areaSelection) {
      const left = Math.min(areaSelection.start.col, areaSelection.end.col);
      const right = Math.max(areaSelection.start.col, areaSelection.end.col);
      const top = Math.min(areaSelection.start.row, areaSelection.end.row);
      const bottom = Math.max(areaSelection.start.row, areaSelection.end.row);
      const x = offsetX + left * scale;
      const y = offsetY + top * scale;
      const width = (right - left + 1) * scale;
      const height = (bottom - top + 1) * scale;
      context.fillStyle = "rgba(239,109,80,.22)";
      context.fillRect(x, y, width, height);
      context.strokeStyle = "#EF6D50";
      context.lineWidth = Math.max(2, Math.min(4, scale * 0.18));
      context.setLineDash([7, 4]);
      context.strokeRect(x + 1, y + 1, Math.max(1, width - 2), Math.max(1, height - 2));
      context.setLineDash([]);
    }

    context.strokeStyle = "#173533";
    context.lineWidth = 2;
    context.strokeRect(offsetX, offsetY, pattern.width * scale, pattern.height * scale);
  }, [areaSelection, canvasSize, cells, done, editorView, palette, viewMode, visibleSymbols]);

  useEffect(() => {
    const canvas = overviewCanvas.current;
    if (!canvas) return;
    const scale = 3;
    canvas.width = pattern.width * scale;
    canvas.height = pattern.height * scale;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    for (let row = 0; row < pattern.height; row += 1) {
      for (let col = 0; col < pattern.width; col += 1) {
        const index = row * pattern.width + col;
        const symbolIndex = cells[index];
        context.fillStyle = visibleSymbols.has(symbolIndex)
          ? palette[symbolIndex].color
          : "#F7F3EB";
        context.fillRect(col * scale, row * scale, scale, scale);
        if (viewMode === "stitch" && done[index]) {
          context.fillStyle = "rgba(255,255,255,.62)";
          context.fillRect(col * scale, row * scale, scale, scale);
        }
      }
    }

    context.strokeStyle = "rgba(20,57,55,.24)";
    context.lineWidth = 1;
    for (let col = 0; col <= pattern.width; col += pattern.sectorSize) {
      context.beginPath();
      context.moveTo(col * scale + 0.5, 0);
      context.lineTo(col * scale + 0.5, canvas.height);
      context.stroke();
    }
    for (let row = 0; row <= pattern.height; row += pattern.sectorSize) {
      context.beginPath();
      context.moveTo(0, row * scale + 0.5);
      context.lineTo(canvas.width, row * scale + 0.5);
      context.stroke();
    }

    if (canvasSize.width && canvasSize.height) {
      const left = Math.max(0, -editorView.offsetX / editorView.scale);
      const top = Math.max(0, -editorView.offsetY / editorView.scale);
      const right = Math.min(
        pattern.width,
        (canvasSize.width - editorView.offsetX) / editorView.scale,
      );
      const bottom = Math.min(
        pattern.height,
        (canvasSize.height - editorView.offsetY) / editorView.scale,
      );
      context.fillStyle = "rgba(239,109,80,.10)";
      context.fillRect(
        left * scale,
        top * scale,
        Math.max(1, (right - left) * scale),
        Math.max(1, (bottom - top) * scale),
      );
      context.strokeStyle = "#F06D4F";
      context.lineWidth = 5;
      context.strokeRect(
        left * scale + 2,
        top * scale + 2,
        Math.max(1, (right - left) * scale - 4),
        Math.max(1, (bottom - top) * scale - 4),
      );
    }
  }, [canvasSize, cells, done, editorView, palette, viewMode, visibleSymbols]);

  const pointFromPointer = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    clampToPattern = false,
  ): CellPoint | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    let col = Math.floor((event.clientX - rect.left - editorView.offsetX) / editorView.scale);
    let row = Math.floor((event.clientY - rect.top - editorView.offsetY) / editorView.scale);
    if (clampToPattern) {
      col = Math.max(0, Math.min(pattern.width - 1, col));
      row = Math.max(0, Math.min(pattern.height - 1, row));
      return { col, row };
    }
    if (col < 0 || col >= pattern.width || row < 0 || row >= pattern.height) return null;
    return { col, row };
  };

  const cellFromPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = pointFromPointer(event);
    return point ? point.row * pattern.width + point.col : null;
  };

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "pan" || event.button === 1) {
      panStart.current = {
        x: event.clientX,
        y: event.clientY,
        offsetX: editorView.offsetX,
        offsetY: editorView.offsetY,
      };
      setIsPanning(true);
      return;
    }
    const point = pointFromPointer(event);
    if (!point) return;
    if (tool === "area") {
      const selection = { start: point, end: point };
      areaSelectionRef.current = selection;
      setAreaSelection(selection);
      return;
    }
    const index = point.row * pattern.width + point.col;
    paintedInStroke.current = new Set([index]);
    painting.current = viewMode === "stitch" || tool === "brush";
    editCell(index);
  };

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (panStart.current) {
      const start = panStart.current;
      setEditorView((current) =>
        constrainView(
          {
            ...current,
            offsetX: start.offsetX + event.clientX - start.x,
            offsetY: start.offsetY + event.clientY - start.y,
          },
          canvasSize.width,
          canvasSize.height,
        ),
      );
      return;
    }
    if (areaSelectionRef.current) {
      if (event.buttons !== 1) return;
      const point = pointFromPointer(event, true);
      if (!point) return;
      const selection = { start: areaSelectionRef.current.start, end: point };
      areaSelectionRef.current = selection;
      setAreaSelection(selection);
      return;
    }
    if (!painting.current || event.buttons !== 1) return;
    const index = cellFromPointer(event);
    if (index === null || paintedInStroke.current.has(index)) return;
    paintedInStroke.current.add(index);
    editCell(index);
  };

  const stopCanvasInteraction = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (areaSelectionRef.current && event.type !== "pointercancel") {
      applyAreaSelection(areaSelectionRef.current);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    painting.current = false;
    paintedInStroke.current.clear();
    panStart.current = null;
    areaSelectionRef.current = null;
    setAreaSelection(null);
    setIsPanning(false);
  };

  const handleCanvasWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    zoomAt(
      event.deltaY < 0 ? 1.16 : 1 / 1.16,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };

  const handleOverviewClick = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const col = Math.min(
      pattern.width - 1,
      Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * pattern.width)),
    );
    const row = Math.min(
      pattern.height - 1,
      Math.max(0, Math.floor(((event.clientY - rect.top) / rect.height) * pattern.height)),
    );
    centerEditorOn(col, row);
  };

  const toggleSymbolVisibility = (index: number) => {
    setVisibleSymbols((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const openAddColorDialog = () => {
    setNewColorName("Свой цвет");
    setNewColorDmc("");
    setNewColorValue("#4B1D68");
    setAddColorDialogOpen(true);
  };

  const addCustomColor = () => {
    const symbol = [...paletteSymbolPool].find(
      (candidate) => !palette.some((item) => item.symbol === candidate),
    );
    if (!symbol) {
      window.alert("Достигнут предел количества цветов в одной схеме.");
      return;
    }

    const color = newColorValue.toUpperCase();
    const name = newColorName.trim() || "Свой цвет";
    const nextIndex = palette.length;
    const item: PaletteItem = {
      symbol,
      dmc: newColorDmc.trim().slice(0, 18),
      name: name.slice(0, 40),
      color,
      textColor: getTextColor(color),
      count: 0,
    };

    setPalette((current) => [...current, item]);
    setVisibleSymbols((current) => new Set(current).add(nextIndex));
    selectSymbol(nextIndex);
    setTool("brush");
    setAddColorDialogOpen(false);
    setSaveLabel("Сохраняю…");
  };

  const resetProject = () => {
    if (!window.confirm("Вернуть исходную схему и цвета? Все ваши изменения будут удалены.")) return;
    cellsRef.current = buildInitialCells();
    doneRef.current = new Uint8Array(pattern.width * pattern.height);
    setCells(cellsRef.current);
    setDone(doneRef.current);
    undoStack.current = [];
    redoStack.current = [];
    setHistoryCounts({ undo: 0, redo: 0 });
    setPalette(pattern.palette.map((item) => ({ ...item })));
    setVisibleSymbols(new Set(pattern.palette.map((_, index) => index)));
    selectSymbol(1);
    setAddColorDialogOpen(false);
    window.localStorage.removeItem(storageKey);
    setSaveLabel("Исходная схема восстановлена");
    fitEditor();
  };

  const exportJson = () => {
    downloadBlob(
      "embroidery-pattern.json",
      new Blob([serializeProject()], { type: "application/json" }),
    );
  };

  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    try {
      const imported = JSON.parse(await file.text()) as ImportedProject;
      setPendingImport(restoreImportedProject(imported, file.name, "file"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Неизвестная ошибка файла.";
      setSaveLabel("Ошибка загрузки");
      window.alert(`Не удалось загрузить проект. ${message}`);
    }
  };

  const confirmImport = () => {
    if (!pendingImport) return;
    cellsRef.current = pendingImport.cells;
    doneRef.current = pendingImport.done;
    setCells(pendingImport.cells);
    setDone(pendingImport.done);
    setPalette(pendingImport.palette);
    setVisibleSymbols(
      new Set(pendingImport.palette.map((_, index) => index)),
    );
    selectSymbol(Math.min(1, pendingImport.palette.length - 1));
    undoStack.current = [];
    redoStack.current = [];
    setHistoryCounts({ undo: 0, redo: 0 });
    setTool("pan");
    if (pendingImport.source === "cloud") {
      setCloudConnected(true);
      setCloudAutoSave(true);
      setCloudLastSaved(new Date().toLocaleString("ru-RU"));
      setCloudStatus("Загружено из Drive · автосинхронизация включена");
      setSaveLabel("Загружено из Google Drive");
    }
    setPendingImport(null);
    if (pendingImport.source === "file") setSaveLabel("Проект загружен");
    fitEditor();
  };

  const exportPng = () => {
    const scale = 7;
    const canvas = document.createElement("canvas");
    canvas.width = pattern.width * scale;
    canvas.height = pattern.height * scale;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    const currentCells = cellsRef.current;
    for (let row = 0; row < pattern.height; row += 1) {
      for (let col = 0; col < pattern.width; col += 1) {
        context.fillStyle = palette[currentCells[row * pattern.width + col]].color;
        context.fillRect(col * scale, row * scale, scale, scale);
      }
    }
    canvas.toBlob((blob) => {
      if (blob) downloadBlob("embroidery-pattern.png", blob);
    }, "image/png");
  };

  const changeMode = (mode: ViewMode) => {
    setViewMode(mode);
    setTool(mode === "stitch" ? "brush" : "pan");
  };

  return (
    <>
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={() => setGoogleScriptReady(true)}
        onError={() => setCloudStatus("Не удалось загрузить сервис Google")}
      />
      <main className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true"><Grid3X3 /></span>
          <span><strong>СТЕЖОК</strong><small>редактор схем</small></span>
        </div>

        <div className={styles.documentTitle}>
          <span className={styles.documentIcon} aria-hidden="true"><Sparkles /></span>
          <span>
            <strong>{pattern.title}</strong>
            <small>{pattern.width} × {pattern.height} крестиков · {palette.length} цветов</small>
          </span>
        </div>

        <div className={styles.topActions}>
          <span className={styles.saveState}><Save /> {saveLabel}</span>
          <input
            ref={importInput}
            className={styles.fileInput}
            type="file"
            accept=".json,application/json"
            onChange={importJson}
          />
          <button className={styles.headerButton} onClick={() => importInput.current?.click()} type="button">
            <Upload /> Загрузить
          </button>
          <button className={styles.headerButton} onClick={exportJson} type="button"><FileJson /> Сохранить</button>
          <button
            className={`${styles.headerButton} ${cloudConnected ? styles.cloudButtonActive : ""}`}
            onClick={() => setCloudDialogOpen(true)}
            type="button"
          >
            <Cloud /> Облако
          </button>
          <button className={styles.headerButtonPrimary} onClick={exportPng} type="button"><Download /> PNG</button>
        </div>
      </header>

      <section className={styles.modeBar} aria-label="Режим работы">
        <div className={styles.modeSwitch}>
          <button className={viewMode === "edit" ? styles.modeActive : ""} onClick={() => changeMode("edit")} type="button"><Palette /> Редактор</button>
          <button className={viewMode === "stitch" ? styles.modeActive : ""} onClick={() => changeMode("stitch")} type="button"><Check /> Процесс вышивки</button>
        </div>
        <p>
          {viewMode === "edit"
            ? "Вся схема открыта целиком — приближайте и редактируйте нужные клетки"
            : "Приближайте схему и отмечайте уже вышитые крестики"}
        </p>
      </section>

      <div className={styles.workspace}>
        <aside className={`${styles.panel} ${styles.overviewPanel}`}>
          <div className={styles.panelHeading}>
            <span><small>Навигация</small><strong><MapIcon /> Карта схемы</strong></span>
            <em>{pattern.width} × {pattern.height}</em>
          </div>

          <div className={styles.overviewStage}>
            <div className={styles.overviewFrame}>
              <canvas
                ref={overviewCanvas}
                onPointerDown={handleOverviewClick}
                className={styles.overviewCanvas}
                style={{ width: `${mapZoom * 100}%` }}
                aria-label="Карта схемы. Нажмите, чтобы перейти к нужному месту"
              />
            </div>
            <div className={styles.mapZoomControls} aria-label="Масштаб карты">
              <button onClick={() => setMapZoom((current) => Math.max(1, current - 0.5))} disabled={mapZoom <= 1} type="button" aria-label="Уменьшить карту"><Minus /></button>
              <button onClick={() => setMapZoom((current) => Math.min(4, current + 0.5))} disabled={mapZoom >= 4} type="button" aria-label="Увеличить карту"><Plus /></button>
            </div>
          </div>

          <div className={styles.overviewMeta}>
            <span><small>Масштаб редактора</small><strong>{zoomPercent}%</strong></span>
            <span><small>Видимая область</small><strong>{visibleRange.left}–{visibleRange.right} / {visibleRange.top}–{visibleRange.bottom}</strong></span>
          </div>

          <div className={styles.progressCard}>
            <div><span><Check /></span><p><strong>{completed.toLocaleString("ru-RU")}</strong><small>из {cells.length.toLocaleString("ru-RU")} готово</small></p></div>
            <div className={styles.progressTrack}><i style={{ width: `${(completed / cells.length) * 100}%` }} /></div>
            <small>{((completed / cells.length) * 100).toFixed(1)}% схемы</small>
          </div>

          <button className={styles.resetButton} onClick={resetProject} type="button"><RotateCcw /> Вернуть исходную схему</button>
        </aside>

        <section className={`${styles.panel} ${styles.editorPanel}`}>
          <div className={styles.editorHeading}>
            <div>
              <small>Рабочая область</small>
              <h1>Полная схема</h1>
              <p>{pattern.width} × {pattern.height} крестиков · колесо мыши меняет масштаб</p>
            </div>
            <div className={styles.editorZoomControls} aria-label="Масштаб редактора">
              <button onClick={() => zoomAt(1 / 1.25)} type="button" aria-label="Уменьшить"><ZoomOut /></button>
              <span>{zoomPercent}%</span>
              <button onClick={() => zoomAt(1.25)} type="button" aria-label="Увеличить"><ZoomIn /></button>
              <button onClick={fitEditor} type="button" aria-label="Показать всю схему"><Maximize2 /></button>
            </div>
          </div>

          <div className={styles.toolbar} aria-label="Инструменты редактора">
            <button className={tool === "pan" ? styles.toolActive : ""} onClick={() => setTool("pan")} type="button"><Hand /> Двигать</button>
            {viewMode === "edit" ? (
              <>
                <button className={tool === "brush" ? styles.toolActive : ""} onClick={() => setTool("brush")} type="button"><Brush /> Кисть <kbd>B</kbd></button>
                <button className={tool === "area" ? styles.toolActive : ""} onClick={() => setTool("area")} type="button"><SquareDashedMousePointer /> Область <kbd>R</kbd></button>
                <button className={tool === "fill" ? styles.toolActive : ""} onClick={() => setTool("fill")} type="button"><PaintBucket /> Заливка <kbd>F</kbd></button>
                <button className={tool === "picker" ? styles.toolActive : ""} onClick={() => setTool("picker")} type="button"><Pipette /> Пипетка <kbd>I</kbd></button>
              </>
            ) : (
              <>
                <button className={tool === "brush" ? styles.toolActive : ""} onClick={() => setTool("brush")} type="button"><Check /> Отмечать</button>
                <button className={tool === "area" ? styles.toolActive : ""} onClick={() => setTool("area")} type="button"><SquareDashedMousePointer /> Область</button>
              </>
            )}
            <i />
            <button onClick={undo} disabled={historyCounts.undo === 0 || viewMode === "stitch"} type="button" aria-label="Отменить"><Undo2 /></button>
            <button onClick={redo} disabled={historyCounts.redo === 0 || viewMode === "stitch"} type="button" aria-label="Повторить"><Redo2 /></button>
          </div>

          <div ref={editorViewport} className={styles.fullPatternViewport}>
            <canvas
              ref={editorCanvas}
              className={`${styles.fullPatternCanvas} ${tool === "pan" ? styles.canvasPan : styles.canvasEdit} ${isPanning ? styles.canvasPanning : ""}`}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={stopCanvasInteraction}
              onPointerCancel={stopCanvasInteraction}
              onWheel={handleCanvasWheel}
              onContextMenu={(event) => event.preventDefault()}
              aria-label="Полная интерактивная схема вышивки"
            />
            <div className={styles.canvasHelp}>
              {tool === "area" ? <SquareDashedMousePointer /> : <Hand />}
              {tool === "area"
                ? "Протяните рамку по нужным клеткам"
                : "Перетаскивайте схему · колесо — масштаб"}
            </div>
          </div>

          <footer className={styles.editorFooter}>
            <span><i className={styles.footerDotActive} /> рамка видимой области на карте</span>
            <span><i className={styles.footerDotGrid} /> линии каждые 10 крестиков</span>
            <strong>{viewMode === "edit" ? `Активный цвет: ${palette[selectedSymbol].symbol} · ${getPaletteLabel(palette[selectedSymbol])}` : `${completed} крестиков отмечено`}</strong>
          </footer>
        </section>

        <aside className={`${styles.panel} ${styles.palettePanel}`}>
          <div className={styles.panelHeading}>
            <span><small>Материалы</small><strong><Palette /> Палитра DMC</strong></span>
            <em>{palette.length} цветов</em>
          </div>

          <div className={styles.paletteList}>
            {palette.map((item, index) => {
              const visible = visibleSymbols.has(index);
              return (
                <div className={`${styles.paletteRow} ${selectedSymbol === index ? styles.paletteSelected : ""}`} key={item.symbol}>
                  <button className={styles.paletteMain} onClick={() => selectSymbol(index)} type="button">
                    <span className={styles.swatch} style={{ background: item.color, color: item.textColor }}>{item.symbol}</span>
                    <span className={styles.paletteCopy}><strong>{item.name}</strong><small>{getPaletteLabel(item)} · {counts[index].toLocaleString("ru-RU")}</small></span>
                    {selectedSymbol === index && <Check className={styles.selectedCheck} />}
                  </button>
                  <label className={styles.colorPicker} title="Изменить цвет">
                    <input
                      type="color"
                      value={item.color}
                      onChange={(event) => {
                        const color = event.target.value.toUpperCase();
                        setPalette((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, color, textColor: getTextColor(color) } : entry));
                        setSaveLabel("Сохраняю…");
                      }}
                      aria-label={`Изменить цвет ${item.name}`}
                    />
                    <Pipette />
                  </label>
                  <button className={styles.visibilityButton} onClick={() => toggleSymbolVisibility(index)} type="button" aria-label={visible ? `Скрыть цвет ${item.name}` : `Показать цвет ${item.name}`}>
                    {visible ? <Eye /> : <EyeOff />}
                  </button>
                </div>
              );
            })}
          </div>

          <button
            className={styles.addColorButton}
            onClick={openAddColorDialog}
            type="button"
          >
            <Plus /> Добавить свой цвет
          </button>

          <div className={styles.paletteTip}>
            <span><Brush /></span>
            <p><strong>Цвет редактируется</strong><small>Нажмите на пипетку справа и выберите новый оттенок — он обновится во всей схеме.</small></p>
          </div>
        </aside>
      </div>

      {addColorDialogOpen && (
        <div className={styles.importOverlay}>
          <section
            className={styles.colorDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-color-title"
          >
            <header className={styles.colorDialogHeader}>
              <span
                className={styles.colorDialogSwatch}
                style={{
                  background: newColorValue,
                  color: getTextColor(newColorValue),
                }}
                aria-hidden="true"
              >
                {[...paletteSymbolPool].find(
                  (candidate) =>
                    !palette.some((item) => item.symbol === candidate),
                ) ?? "?"}
              </span>
              <div>
                <small>Новый материал</small>
                <h2 id="add-color-title">Добавить свой цвет</h2>
                <p>Он появится в палитре и будет доступен для всех инструментов.</p>
              </div>
            </header>

            <div className={styles.colorDialogFields}>
              <label>
                <span>Название</span>
                <input
                  autoFocus
                  maxLength={40}
                  value={newColorName}
                  onChange={(event) => setNewColorName(event.target.value)}
                  placeholder="Например, тёмно-фиолетовый"
                />
              </label>
              <label>
                <span>Номер DMC <small>необязательно</small></span>
                <input
                  maxLength={18}
                  value={newColorDmc}
                  onChange={(event) => setNewColorDmc(event.target.value)}
                  placeholder="Например, 550"
                />
              </label>
              <label className={styles.newColorPicker}>
                <span>Оттенок</span>
                <span>
                  <input
                    type="color"
                    value={newColorValue}
                    onChange={(event) =>
                      setNewColorValue(event.target.value.toUpperCase())
                    }
                    aria-label="Оттенок нового цвета"
                  />
                  <strong>{newColorValue.toUpperCase()}</strong>
                </span>
              </label>
            </div>

            <div className={styles.colorDialogActions}>
              <button onClick={() => setAddColorDialogOpen(false)} type="button">
                Отмена
              </button>
              <button onClick={addCustomColor} type="button">
                <Plus /> Добавить цвет
              </button>
            </div>
          </section>
        </div>
      )}

      {pendingImport && (
        <div className={styles.importOverlay}>
          <section
            className={styles.importDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-project-title"
          >
            <span className={styles.importDialogIcon} aria-hidden="true"><FileJson /></span>
            <div>
              <small>Восстановление проекта</small>
              <h2 id="import-project-title">Загрузить сохранённую схему?</h2>
              <p>Текущий рисунок, изменённые цвета и отметки вышивки будут заменены данными из файла.</p>
              <strong>{pendingImport.filename}</strong>
            </div>
            <div className={styles.importDialogActions}>
              <button onClick={() => setPendingImport(null)} type="button">Отмена</button>
              <button onClick={confirmImport} type="button"><Upload /> Загрузить проект</button>
            </div>
          </section>
        </div>
      )}

      {cloudDialogOpen && (
        <div className={styles.importOverlay}>
          <section
            className={styles.cloudDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cloud-dialog-title"
          >
            <header className={styles.cloudDialogHeader}>
              <span className={styles.cloudDialogIcon} aria-hidden="true"><Cloud /></span>
              <div>
                <small>Облачное сохранение</small>
                <h2 id="cloud-dialog-title">Google Drive</h2>
                <p>Одна приватная копия схемы в скрытой папке данных приложения.</p>
              </div>
              <button
                className={styles.cloudCloseButton}
                onClick={() => setCloudDialogOpen(false)}
                type="button"
                aria-label="Закрыть"
              >
                ×
              </button>
            </header>

            <div className={`${styles.cloudStatus} ${cloudConnected ? styles.cloudStatusConnected : ""}`}>
              <span><Cloud /></span>
              <p>
                <strong>{cloudStatus}</strong>
                <small>
                  {cloudLastSaved
                    ? `Последняя запись: ${cloudLastSaved}`
                    : cloudAutoSave
                      ? "Автосинхронизация включена"
                      : "Локальное сохранение продолжает работать всегда"}
                </small>
              </p>
            </div>

            {!googleClientId ? (
              <div className={styles.cloudSetup}>
                <p>
                  Для личного Drive нужен бесплатный OAuth Client ID. Он не является
                  паролем и не даёт сайту доступ без вашего подтверждения Google.
                </p>
                <ol>
                  <li>В Google Cloud включите Drive API.</li>
                  <li>Создайте OAuth Client ID типа «Web application».</li>
                  <li>Добавьте источник <code>https://inclement1a.github.io</code>.</li>
                </ol>
                <a
                  href="https://console.cloud.google.com/apis/credentials"
                  target="_blank"
                  rel="noreferrer"
                >
                  Открыть Google Cloud Console ↗
                </a>
                <label>
                  <span>OAuth Client ID</span>
                  <input
                    value={googleClientIdDraft}
                    onChange={(event) => setGoogleClientIdDraft(event.target.value)}
                    placeholder="…apps.googleusercontent.com"
                    autoComplete="off"
                  />
                </label>
                <button className={styles.cloudPrimaryButton} onClick={saveGoogleClientId} type="button">
                  <Settings2 /> Сохранить настройку
                </button>
              </div>
            ) : (
              <div className={styles.cloudControls}>
                {!cloudConnected ? (
                  <button
                    className={styles.cloudPrimaryButton}
                    onClick={() => void connectGoogleDrive()}
                    disabled={cloudBusy || !googleScriptReady}
                    type="button"
                  >
                    <Cloud /> {googleScriptReady ? "Подключить Google Drive" : "Загружаем Google…"}
                  </button>
                ) : (
                  <div className={styles.cloudActionGrid}>
                    <button
                      onClick={() => void loadFromGoogleDrive()}
                      disabled={cloudBusy}
                      type="button"
                    >
                      <CloudDownload /> Загрузить из Drive
                    </button>
                    <button
                      className={styles.cloudPrimaryButton}
                      onClick={() => void saveToGoogleDrive()}
                      disabled={cloudBusy}
                      type="button"
                    >
                      <CloudUpload /> Сохранить в Drive
                    </button>
                  </div>
                )}

                <div className={styles.cloudPrivacyNote}>
                  <strong>Доступ ограничен</strong>
                  <p>Сайт видит только собственную скрытую копию. Остальные файлы Google Drive недоступны.</p>
                </div>

                <details className={styles.cloudAdvanced}>
                  <summary>Настройка подключения</summary>
                  <label>
                    <span>OAuth Client ID</span>
                    <input
                      value={googleClientIdDraft}
                      onChange={(event) => setGoogleClientIdDraft(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <div>
                    {!defaultGoogleClientId && (
                      <button onClick={saveGoogleClientId} type="button"><Settings2 /> Обновить ID</button>
                    )}
                    {cloudConnected && (
                      <button onClick={disconnectGoogleDrive} type="button">Отключить Drive</button>
                    )}
                  </div>
                </details>
              </div>
            )}
          </section>
        </div>
      )}
      </main>
    </>
  );
}
