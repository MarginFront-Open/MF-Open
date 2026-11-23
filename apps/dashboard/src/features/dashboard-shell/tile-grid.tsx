'use client'

/**
 * Tiles → 12-col grid. The GRID owns
 * order/spans/edit-chrome; the PAGE owns data via renderTile. Drag-reorder
 * is @dnd-kit core + sortable; no resize interaction exists.
 *
 * Drag model: two bands (KPIs first, split via
 * layout-state.ts#bandIndices), each its own DndContext — a drag can only
 * target a slot in its own band. One closestCenter space over mixed spans
 * would resolve drops to tiles the pointer isn't over. Strategies differ per
 * band on purpose: the uniform-span KPI band live-reflows with
 * rectSortingStrategy (transforms are pure translate, and the parted gap IS
 * the insertion indicator), while the mixed-span content band keeps the
 * null strategy + DragOverlay ghost + drop-target ring, because
 * live reflow over mixed spans scales tiles into each other's slots.
 * Transforms are hand-built translate3d strings rather than the dnd-kit
 * transform helper so scale can't sneak back in through a strategy change.
 */

import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  type SortingStrategy,
} from '@dnd-kit/sortable'
import {
  ADDABLE_METRICS,
  COMPONENT_LABELS,
  DIMENSION_LABELS,
  DIMENSIONED_COMPONENTS,
  SPAN_BY_COMPONENT,
  TILE_METRIC_REGISTRY,
  TileInputSchema,
  tileConfigKey,
  type ComponentId,
  type DashboardLayoutTile,
  type DashboardPageId,
  type Dimension,
  type TileMetric,
} from '@/lib/component-catalog'
import { cn } from '@/lib/utils'
import { ADDABLE_COMPONENTS } from './default-layouts'
import { bandIndices, type TileBand } from './layout-state'
import type { TileGridProps } from './types'

// Static class strings — Tailwind can't see dynamically-built class names.
// Fixed size ≠ fixed at every breakpoint: spans collapse below lg.
const SPAN_CLASS: Record<3 | 4 | 8 | 12, string> = {
  3: 'col-span-12 sm:col-span-6 lg:col-span-3',
  4: 'col-span-12 sm:col-span-6 lg:col-span-4',
  8: 'col-span-12 lg:col-span-8',
  12: 'col-span-12',
}

// Content-band tiles hold their slot until drop — the DragOverlay ghost is
// the only thing that moves (see header comment).
const noLivePreview: SortingStrategy = () => null

// The reflow's ~200ms slide conveys nothing beyond its endpoint, so
// reduced-motion users get the endpoint instantly. Read per drag, not at
// module load: the OS setting can change mid-session.
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

const BAND_LABELS: Record<TileBand, string> = {
  kpi: 'KPI tiles',
  content: 'Content tiles',
}

export function TileGrid({
  page,
  tiles,
  editing = false,
  onMove,
  onRemove,
  onAdd,
  renderTile,
}: TileGridProps) {
  const bands = bandIndices(tiles)

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-col gap-3'>
        {(['kpi', 'content'] as const).map((band) => (
          <BandGrid
            key={band}
            band={band}
            indices={bands[band]}
            tiles={tiles}
            editing={editing}
            onMove={onMove}
            onRemove={onRemove}
            renderTile={renderTile}
          />
        ))}
      </div>
      {editing && onAdd && (
        <AddTilePanel page={page} tiles={tiles} onAdd={onAdd} />
      )}
    </div>
  )
}

function BandGrid({
  band,
  indices,
  tiles,
  editing,
  onMove,
  onRemove,
  renderTile,
}: {
  band: TileBand
  indices: number[]
  tiles: DashboardLayoutTile[]
  editing: boolean
  onMove?: TileGridProps['onMove']
  onRemove?: TileGridProps['onRemove']
  renderTile: TileGridProps['renderTile']
}) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  if (indices.length === 0) return null

  const cells = indices.map((index) => {
    const tile = tiles[index]
    // A bad row (e.g. from a future schema change) renders an inline
    // unknown-tile card — never crashes the page.
    const valid = TileInputSchema.safeParse(tile).success
    const spanClass = valid
      ? SPAN_CLASS[SPAN_BY_COMPONENT[tile.component]]
      : SPAN_CLASS[3]
    const content = valid ? (
      renderTile(tile, index)
    ) : (
      <div className='flex h-full min-h-[90px] items-center rounded-mf-card border border-mf-bd bg-mf-card px-[15px] py-[14px]'>
        <span className='text-[11.5px] text-mf-tx3'>
          This tile isn&apos;t recognized. Remove it, or it will be skipped.
        </span>
      </div>
    )

    if (!editing) {
      return (
        <div key={index} className={spanClass}>
          {content}
        </div>
      )
    }
    return (
      <SortableCell
        key={index}
        id={String(index)}
        spanClass={spanClass}
        liveReflow={band === 'kpi'}
        draggable={Boolean(onMove)}
        onRemove={onRemove ? () => onRemove(index) : undefined}
      >
        {content}
      </SortableCell>
    )
  })

  // overflow-x-clip is the mid-drag guard: whatever a future interaction
  // does inside the grid, it can never push horizontal overflow onto the
  // page (clip, not hidden — hidden would force overflow-y to auto and
  // grow a scrollbar).
  const grid = (
    <div className='grid grid-cols-12 gap-3 overflow-x-clip'>{cells}</div>
  )

  const handleDragStart = (event: DragStartEvent) => {
    setActiveIndex(Number(event.active.id))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveIndex(null)
    if (!onMove || !event.over) return
    const from = Number(event.active.id)
    const to = Number(event.over.id)
    if (from !== to) onMove(from, to)
  }

  const activeTile = activeIndex !== null ? tiles[activeIndex] : null

  if (!(editing && onMove)) {
    return grid
  }

  return (
    <div className='flex flex-col gap-1.5'>
      <p className='text-[10px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
        {BAND_LABELS[band]}
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveIndex(null)}
      >
        <SortableContext
          items={indices.map(String)}
          strategy={band === 'kpi' ? rectSortingStrategy : noLivePreview}
        >
          {grid}
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeTile !== null && activeIndex !== null ? (
            <div className='cursor-grabbing opacity-90 shadow-2xl'>
              {renderTile(activeTile, activeIndex)}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

function SortableCell({
  id,
  spanClass,
  liveReflow,
  draggable,
  onRemove,
  children,
}: {
  id: string
  spanClass: string
  liveReflow: boolean
  draggable: boolean
  onRemove?: () => void
  children: ReactNode
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id, disabled: !draggable })

  // Translate-only on purpose: rectSortingStrategy also emits scale factors,
  // and applying those is exactly the mixed-span blow-up. Within the
  // uniform KPI band the factors are 1 anyway, so dropping them costs nothing.
  const style: CSSProperties | undefined =
    liveReflow && !isDragging && transform
      ? {
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
          transition: prefersReducedMotion() ? undefined : transition,
        }
      : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        spanClass,
        'group relative',
        // Reflow band: the source goes invisible but KEEPS its slot, so the
        // parted gap reads as the insertion point. Ghost band: source stays
        // dimmed and the drop target gets a ring (nothing else moves mid-drag).
        isDragging && (liveReflow ? 'opacity-0' : 'opacity-40'),
        !liveReflow &&
          !isDragging &&
          isOver &&
          'rounded-mf-card ring-2 ring-mf-accent'
      )}
    >
      {draggable && (
        <button
          type='button'
          {...attributes}
          {...listeners}
          aria-label='Drag to reorder'
          className='absolute left-1.5 top-1.5 z-10 cursor-grab rounded-mf-seg-item px-1 text-[11px] leading-none text-mf-tx3 hover:text-mf-tx active:cursor-grabbing'
        >
          <SixDotHandle />
        </button>
      )}
      {onRemove && (
        <button
          type='button'
          onClick={onRemove}
          aria-label='Remove tile'
          className='absolute right-1.5 top-1.5 z-10 rounded-mf-seg-item px-1.5 text-[12px] leading-none text-mf-tx3 hover:text-mf-red'
        >
          ✕
        </button>
      )}
      {children}
    </div>
  )
}

function SixDotHandle() {
  return (
    <svg
      width='10'
      height='14'
      viewBox='0 0 10 14'
      fill='currentColor'
      aria-hidden
    >
      {[0, 1, 2].map((row) =>
        [0, 1].map((col) => (
          <circle
            key={`${row}-${col}`}
            cx={2.5 + col * 5}
            cy={2.5 + row * 4.5}
            r={1.2}
          />
        ))
      )}
    </svg>
  )
}

// What "＋ Trend chart" will actually add — the panel must know the exact
// config up front to grey out ones already on the grid. A second chart with
// a DIFFERENT dimension stays legal: add it, then re-point it with the
// tile's own dimension picker.
const DEFAULT_ADD_DIMENSION: Partial<Record<ComponentId, Dimension>> = {
  'timeseries-chart': 'day',
  'category-donut': 'costCategory',
  'breakdown-table': 'customer',
}

// Per-page overrides: FinOps additions open on Category, Money keeps
// Customer, everything else keeps the base default.
const PAGE_ADD_DIMENSION: Partial<
  Record<DashboardPageId, Partial<Record<ComponentId, Dimension>>>
> = {
  finops: {
    'category-donut': 'costCategory',
    'breakdown-table': 'costCategory',
  },
}

export function defaultAddDimension(
  page: DashboardPageId,
  component: ComponentId
): Dimension | undefined {
  return (
    PAGE_ADD_DIMENSION[page]?.[component] ?? DEFAULT_ADD_DIMENSION[component]
  )
}

interface AddOption {
  label: string
  component: ComponentId
  metric?: TileMetric
  dimension?: Dimension
}

function addOptionsFor(page: TileGridProps['page']): AddOption[] {
  return ADDABLE_COMPONENTS[page].flatMap((component): AddOption[] => {
    if (component === 'kpi-tile') {
      // Gated per page: only metrics component-catalog.ts's
      // ADDABLE_METRICS allows for this page, never the full registry.
      return ADDABLE_METRICS[page].map((metric) => ({
        label: `KPI · ${TILE_METRIC_REGISTRY[metric].label}`,
        component,
        metric,
      }))
    }
    if (DIMENSIONED_COMPONENTS.has(component)) {
      return [
        {
          label: COMPONENT_LABELS[component],
          component,
          dimension: defaultAddDimension(page, component),
        },
      ]
    }
    return [{ label: COMPONENT_LABELS[component], component }]
  })
}

function AddTilePanel({
  page,
  tiles,
  onAdd,
}: {
  page: TileGridProps['page']
  tiles: DashboardLayoutTile[]
  onAdd: NonNullable<TileGridProps['onAdd']>
}) {
  const options = addOptionsFor(page)
  if (options.length === 0) return null

  const usedConfigs = new Set(tiles.map((tile) => tileConfigKey(tile)))

  // Grouped by destination band so "add" answers "where will it appear?" up front.
  const groups: Array<{ label: string; options: AddOption[] }> = [
    {
      label: BAND_LABELS.kpi,
      options: options.filter((option) => option.component === 'kpi-tile'),
    },
    {
      label: BAND_LABELS.content,
      options: options.filter((option) => option.component !== 'kpi-tile'),
    },
  ].filter((group) => group.options.length > 0)

  return (
    <div className='rounded-mf-card border border-mf-bd bg-mf-card px-[17px] py-[15px]'>
      <p className='text-[10.5px] font-semibold uppercase tracking-[.05em] text-mf-tx3'>
        Add a tile
      </p>
      {groups.map((group) => (
        <div key={group.label} className='mt-2.5'>
          <p className='text-[10px] font-medium text-mf-tx3'>{group.label}</p>
          <div className='mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5'>
            {group.options.map((option) => {
              const alreadyAdded = usedConfigs.has(tileConfigKey(option))
              return (
                <button
                  key={tileConfigKey(option)}
                  type='button'
                  disabled={alreadyAdded}
                  onClick={() =>
                    onAdd(option.component, {
                      metric: option.metric,
                      dimension: option.dimension,
                    })
                  }
                  className={cn(
                    'rounded-mf-inner border border-mf-bd bg-mf-bg px-3 py-2.5 text-left text-[12px] font-medium',
                    alreadyAdded
                      ? 'cursor-not-allowed opacity-45'
                      : 'text-mf-tx2 hover:border-mf-accent hover:text-mf-tx'
                  )}
                >
                  {alreadyAdded ? '✓ ' : '＋ '}
                  {option.label}
                  {alreadyAdded && (
                    <span className='block text-[10px] font-normal text-mf-tx3'>
                      Already added
                      {option.dimension
                        ? ` (${DIMENSION_LABELS[option.dimension]})`
                        : ''}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
