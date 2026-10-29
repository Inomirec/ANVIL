import { mediaUrl } from '../lib/api'
import { humanSize } from '../lib/format'
import type { FileInfo } from '../lib/types'
import { useZoomPan } from '../lib/zoomPan'

/**
 * Просмотр GIF. Редактор картинок здесь не к месту: гифку перегоняют в
 * видео, а закраска и обрезка из редактора до видео не доходят — лучше их не
 * показывать, чем дать крутить то, что ничего не меняет.
 */
export function GifView({ file }: { file: FileInfo }) {
  const zoom = useZoomPan(file.path, 8, 0.4)
  const media = file.media
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={zoom.shell}
        onMouseDown={zoom.onMouseDown}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4 stage"
      >
        {zoom.view !== 1 && (
          <button
            type="button"
            onClick={zoom.reset}
            title="Масштаб просмотра — на готовый файл не влияет. Нажмите, чтобы вернуть обычный размер."
            className="absolute right-2 top-2 z-10 bg-accent/25 px-2 py-1 font-mono text-[11px] tabular-nums text-accent-soft backdrop-blur hover:bg-accent/35"
          >
            {Math.round(zoom.view * 100)}%
          </button>
        )}
        <img
          key={file.path}
          src={mediaUrl(file.path)}
          alt=""
          draggable={false}
          className="max-h-full max-w-full object-contain shadow-xl ring-1 ring-line"
          style={{ transform: zoom.transform, imageRendering: zoom.view >= 3 ? 'pixelated' : undefined }}
        />
      </div>
      <p className="truncate border-t border-line-soft bg-surface px-3 py-2 text-center text-[12px] text-ink-faint">
        {file.name}
        {media?.width ? ` · ${media.width}×${media.height}` : ''}
        {media?.duration ? ` · ${media.duration.toFixed(1)} с` : ''} · {humanSize(file.size)}
      </p>
    </div>
  )
}
