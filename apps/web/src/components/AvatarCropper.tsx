import { useEffect, useRef, useState } from "react";

// Square crop editor (Canvas API only, no new dependencies). The preview
// box is fixed at DISPLAY_PX so the display->source math stays exact; the
// exported canvas is always OUTPUT_PX (1:1, no other aspect ratios).
const DISPLAY_PX = 256;
const OUTPUT_PX = 512;
// Must match the server avatar limit (server re-validates regardless).
const MAX_AVATAR_BYTES = 512 * 1024;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const MIN_JPEG_QUALITY = 0.5;

const SUPPORTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (quality === undefined) canvas.toBlob((b) => resolve(b), type);
    else canvas.toBlob((b) => resolve(b), type, quality);
  });
}

export default function AvatarCropper({
  src,
  onCancel,
  onConfirm,
}: {
  src: string;
  onCancel: () => void;
  onConfirm: (file: File) => void;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      setImg(image);
      setOffset({ x: 0, y: 0 });
      setScale(1);
    };
    image.onerror = () => {
      if (!cancelled) setLoadError(true);
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  const natW = img?.naturalWidth ?? 0;
  const natH = img?.naturalHeight ?? 0;
  // Base scale fits the image to cover the square box (1:1 cover).
  const base =
    natW > 0 && natH > 0 ? Math.max(DISPLAY_PX / natW, DISPLAY_PX / natH) : 1;

  const clampOffset = (x: number, y: number, s: number) => {
    const ex = Math.max(0, (natW * base * s - DISPLAY_PX) / 2);
    const ey = Math.max(0, (natH * base * s - DISPLAY_PX) / 2);
    return {
      x: Math.min(ex, Math.max(-ex, x)),
      y: Math.min(ey, Math.max(-ey, y)),
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: offset.x,
      origY: offset.y,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset(
      clampOffset(d.origX + e.clientX - d.startX, d.origY + e.clientY - d.startY, scale),
    );
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const onZoom = (next: number) => {
    setScale(next);
    setOffset((prev) => clampOffset(prev.x, prev.y, next));
  };

  const confirm = async () => {
    if (!img || processing) return;
    setProcessing(true);
    setProcessError(null);
    try {
      // src is a blob: URL of the picked file, so fetching it reveals the
      // original mime without extra props. The output keeps the SAME mime
      // the server expects (jpeg/png/webp); never trusted from the client.
      const originalType = await fetch(src)
        .then((r) => r.blob())
        .then((b) => b.type)
        .catch(() => "");
      const mime = SUPPORTED_TYPES.includes(originalType) ? originalType : "image/png";
      const ext = mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : ".png";
      // Map the visible square back to source pixels: the displayed center
      // is the box center plus the drag offset, scaled down by base*scale.
      const side = DISPLAY_PX / (base * scale);
      const cx = natW / 2 - offset.x / (base * scale);
      const cy = natH / 2 - offset.y / (base * scale);
      // Tiny images may be smaller than the crop square: fall back to the
      // whole image (upscaled to the fixed output size).
      const sw = Math.min(side, natW);
      const sh = Math.min(side, natH);
      const sx = Math.min(Math.max(0, cx - sw / 2), Math.max(0, natW - sw));
      const sy = Math.min(Math.max(0, cy - sh / 2), Math.max(0, natH - sh));
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT_PX;
      canvas.height = OUTPUT_PX;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas unavailable");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, OUTPUT_PX, OUTPUT_PX);
      // JPEG quality ladder so the result fits the server size limit.
      // PNG/WebP have no quality loop: their size cannot be reduced
      // without changing format (documented limitation, client re-check
      // in ProfilePage still rejects oversize results before upload).
      let blob: Blob | null;
      if (mime === "image/jpeg") {
        let quality = 0.92;
        blob = await canvasToBlob(canvas, mime, quality);
        while (
          blob &&
          blob.size > MAX_AVATAR_BYTES &&
          quality > MIN_JPEG_QUALITY
        ) {
          quality = Math.max(
            MIN_JPEG_QUALITY,
            Math.round((quality - 0.1) * 100) / 100,
          );
          blob = await canvasToBlob(canvas, mime, quality);
        }
      } else {
        blob = await canvasToBlob(canvas, mime);
      }
      if (!blob) throw new Error("encode failed");
      onConfirm(new File([blob], `avatar-cropped${ext}`, { type: mime }));
    } catch {
      setProcessError("Could not process this image. Try another file.");
    } finally {
      setProcessing(false);
    }
  };

  // Round preview mirrors the square box at a smaller scale.
  const previewK = 64 / DISPLAY_PX;

  return (
    <div>
      <div className="flex flex-wrap items-start gap-4">
        <div
          role="application"
          aria-label="Crop area. Drag to move."
          className="relative h-64 w-64 shrink-0 cursor-grab touch-none overflow-hidden rounded-xl border border-line bg-canvas active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {!img && !loadError && (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-subtle">
              Loading…
            </p>
          )}
          {img && (
            <img
              src={src}
              alt=""
              draggable={false}
              className="absolute max-w-none select-none"
              style={{
                left: "50%",
                top: "50%",
                width: natW * base,
                height: natH * base,
                transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              }}
            />
          )}
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="relative h-16 w-16 overflow-hidden rounded-full border border-line bg-canvas">
            {img && (
              <img
                src={src}
                alt=""
                draggable={false}
                className="absolute max-w-none select-none"
                style={{
                  left: "50%",
                  top: "50%",
                  width: natW * base * previewK,
                  height: natH * base * previewK,
                  transform: `translate(-50%, -50%) translate(${offset.x * previewK}px, ${offset.y * previewK}px) scale(${scale})`,
                }}
              />
            )}
          </div>
          <p className="text-xs text-subtle">Preview</p>
        </div>
      </div>
      <label className="mt-3 block max-w-xs">
        <span className="mb-1 block text-[13px] font-medium">Zoom</span>
        <input
          type="range"
          aria-label="Zoom"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.05}
          value={scale}
          disabled={!img}
          onChange={(e) => onZoom(Number(e.target.value))}
          className="w-full"
        />
      </label>
      {loadError && (
        <p className="mt-2 text-sm text-clay-ink">
          Could not read this file. Choose another photo or cancel.
        </p>
      )}
      {processError && <p className="mt-2 text-sm text-clay-ink">{processError}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={processing}
          className="rounded-xl border border-line bg-surface px-3.5 py-2 text-[13px] font-medium text-subtle transition-colors hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={!img || processing}
          className="rounded-xl bg-ink px-3.5 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {processing ? "Processing…" : "Use photo"}
        </button>
      </div>
    </div>
  );
}
