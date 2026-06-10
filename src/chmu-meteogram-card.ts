/**
 * ČHMÚ Meteogram Card
 *
 * Lovelace karta vykreslující hodinový meteogram (teplota + srážky)
 * z weather entity integrace ha-chmu-meteogram.
 * Vzhled inspirován mobilní aplikací Počasí ČHMÚ.
 */
import { css, html, LitElement, nothing, svg, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";

// ---------------------------------------------------------------------------
// Typy
// ---------------------------------------------------------------------------

interface ForecastItem {
  datetime: string;
  condition?: string;
  temperature?: number | null;
  precipitation?: number | null;
  pressure?: number | null;
  humidity?: number | null;
  wind_speed?: number | null;
  wind_gust_speed?: number | null;
  wind_bearing?: number | null;
  cloud_coverage?: number | null;
}

interface ForecastEvent {
  type: "hourly" | "daily" | "twice_daily";
  forecast: ForecastItem[];
}

interface HassEntity {
  attributes: Record<string, unknown>;
}

interface HomeAssistant {
  states: Record<string, HassEntity | undefined>;
  language?: string;
  locale?: { language?: string };
  connection: {
    subscribeMessage<T>(
      callback: (msg: T) => void,
      params: Record<string, unknown>
    ): Promise<() => Promise<void>>;
  };
}

interface CardConfig {
  type: string;
  entity: string;
  /** Počet zobrazených hodin předpovědi (6–73). */
  hours?: number;
  title?: string;
  show_header?: boolean;
}

const DEFAULT_HOURS = 48;
const MIN_HOURS = 6;
const MAX_HOURS = 73;

// Geometrie kresby (px)
const PLOT_HEIGHT = 240;
const M_TOP = 26;
const M_BOTTOM = 40;
const M_LEFT = 40;
const M_RIGHT = 40;
const BUBBLE_W = 190;

const CONDITION_ICONS: Record<string, string> = {
  "clear-night": "mdi:weather-night",
  cloudy: "mdi:weather-cloudy",
  exceptional: "mdi:alert-circle-outline",
  fog: "mdi:weather-fog",
  hail: "mdi:weather-hail",
  lightning: "mdi:weather-lightning",
  "lightning-rainy": "mdi:weather-lightning-rainy",
  partlycloudy: "mdi:weather-partly-cloudy",
  pouring: "mdi:weather-pouring",
  rainy: "mdi:weather-rainy",
  snowy: "mdi:weather-snowy",
  "snowy-rainy": "mdi:weather-snowy-rainy",
  sunny: "mdi:weather-sunny",
  windy: "mdi:weather-windy",
  "windy-variant": "mdi:weather-windy-variant",
};

// ---------------------------------------------------------------------------
// Pomocné funkce
// ---------------------------------------------------------------------------

/** Hladký SVG path skrz body (Catmull-Rom → kubické Béziery). */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return "";
  const r = (n: number) => Math.round(n * 10) / 10;
  let d = `M ${r(pts[0][0])},${r(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(p2[0])},${r(p2[1])}`;
  }
  return d;
}

/** "Hezký" krok osy pro daný rozsah a cílový počet dílků. */
function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  for (const m of [1, 2, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

// ---------------------------------------------------------------------------
// Karta
// ---------------------------------------------------------------------------

@customElement("chmu-meteogram-card")
export class ChmuMeteogramCard extends LitElement {
  @state() private _config?: CardConfig;
  @state() private _forecast?: ForecastItem[];
  @state() private _width = 0;
  @state() private _error?: string;
  /** Index hodiny vybrané kurzorem; undefined = aktuální hodina. */
  @state() private _selIdx?: number;

  private _hass?: HomeAssistant;
  private _unsub?: Promise<() => Promise<void>>;
  private _subscribedEntity?: string;
  private _resizeObserver?: ResizeObserver;
  private _nowTimer?: number;
  private _dragging = false;

  // ---- konfigurace -------------------------------------------------------

  static getStubConfig(hass: HomeAssistant): Partial<CardConfig> {
    const entities = Object.keys(hass.states);
    const entity =
      entities.find((e) => e.startsWith("weather.chmu_")) ??
      entities.find((e) => e.startsWith("weather.")) ??
      "";
    return { entity, hours: DEFAULT_HOURS };
  }

  static async getConfigElement(): Promise<HTMLElement> {
    return document.createElement("chmu-meteogram-card-editor");
  }

  setConfig(config: CardConfig): void {
    if (!config.entity || !config.entity.startsWith("weather.")) {
      throw new Error("Nastav 'entity' na weather entitu (weather.chmu_*).");
    }
    this._config = config;
    if (this._subscribedEntity && this._subscribedEntity !== config.entity) {
      this._unsubscribe();
      this._forecast = undefined;
      this._selIdx = undefined;
    }
    this._subscribe();
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    this._subscribe();
  }

  getCardSize(): number {
    return 5;
  }

  private get _hours(): number {
    const h = this._config?.hours ?? DEFAULT_HOURS;
    return Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.round(h)));
  }

  private get _lang(): string {
    return this._hass?.locale?.language ?? this._hass?.language ?? "cs";
  }

  // ---- lifecycle / subscription ------------------------------------------

  connectedCallback(): void {
    super.connectedCallback();
    this._resizeObserver = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0 && Math.abs(w - this._width) > 1) this._width = w;
    });
    this._resizeObserver.observe(this);
    // Posun čáry "teď" i bez nových dat
    this._nowTimer = window.setInterval(() => this.requestUpdate(), 5 * 60_000);
    this._subscribe();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._resizeObserver = undefined;
    if (this._nowTimer) {
      clearInterval(this._nowTimer);
      this._nowTimer = undefined;
    }
    this._unsubscribe();
  }

  private _subscribe(): void {
    if (!this.isConnected || !this._hass || !this._config?.entity) return;
    if (this._subscribedEntity === this._config.entity) return;
    this._unsubscribe();
    this._subscribedEntity = this._config.entity;
    this._error = undefined;
    this._unsub = this._hass.connection
      .subscribeMessage<ForecastEvent>(
        (msg) => {
          if (msg.type === "hourly") this._forecast = msg.forecast;
        },
        {
          type: "weather/subscribe_forecast",
          entity_id: this._config.entity,
          forecast_type: "hourly",
        }
      )
      .catch((err: unknown) => {
        this._error = `Nepodařilo se odebírat předpověď pro ${this._config?.entity}: ${err}`;
        this._subscribedEntity = undefined;
        return async () => {};
      });
  }

  private _unsubscribe(): void {
    this._subscribedEntity = undefined;
    if (this._unsub) {
      this._unsub.then((unsub) => unsub()).catch(() => {});
      this._unsub = undefined;
    }
  }

  // ---- kurzor --------------------------------------------------------------

  private _points() {
    return (this._forecast ?? []).slice(0, this._hours).map((f) => ({
      raw: f,
      time: new Date(f.datetime),
      temp: f.temperature ?? null,
      precip: Math.max(0, f.precipitation ?? 0),
    }));
  }

  /** Index bodu nejbližšího aktuálnímu času. */
  private _nowIdx(points: Array<{ time: Date }>): number {
    const now = Date.now();
    let best = 0;
    for (let i = 0; i < points.length; i++) {
      if (
        Math.abs(points[i].time.getTime() - now) <
        Math.abs(points[best].time.getTime() - now)
      ) {
        best = i;
      }
    }
    return best;
  }

  private _idxFromEvent(ev: PointerEvent): number | undefined {
    const svgEl = this.renderRoot.querySelector("svg");
    const n = Math.min(this._forecast?.length ?? 0, this._hours);
    if (!svgEl || n < 2) return undefined;
    const rect = svgEl.getBoundingClientRect();
    const plotW = rect.width - M_LEFT - M_RIGHT;
    const rel = (ev.clientX - rect.left - M_LEFT) / plotW;
    return Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1))));
  }

  private _onPointerDown(ev: PointerEvent): void {
    this._dragging = true;
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    const idx = this._idxFromEvent(ev);
    if (idx !== undefined) this._selIdx = idx;
  }

  private _onPointerMove(ev: PointerEvent): void {
    if (ev.pointerType !== "mouse" && !this._dragging) return;
    const idx = this._idxFromEvent(ev);
    if (idx !== undefined) this._selIdx = idx;
  }

  private _onPointerUp(ev: PointerEvent): void {
    this._dragging = false;
    (ev.currentTarget as Element).releasePointerCapture(ev.pointerId);
  }

  // ---- render --------------------------------------------------------------

  render(): TemplateResult | typeof nothing {
    if (!this._config) return nothing;

    const title =
      this._config.title ??
      (this._hass?.states[this._config.entity]?.attributes
        .friendly_name as string | undefined) ??
      "Meteogram ČHMÚ";

    let body: TemplateResult;
    if (this._error) {
      body = html`<div class="msg error">${this._error}</div>`;
    } else if (!this._forecast || this._forecast.length < 2 || this._width < 100) {
      body = html`<div class="msg">Čekám na data předpovědi…</div>`;
    } else {
      body = this._renderChart();
    }

    return html`
      <ha-card>
        ${this._config.show_header === false
          ? nothing
          : html`<div class="header">${title}</div>`}
        <div class="chart">${body}</div>
      </ha-card>
    `;
  }

  private _renderChart(): TemplateResult {
    const points = this._points();
    const n = points.length;

    const W = this._width;
    const H = PLOT_HEIGHT;
    const plotW = W - M_LEFT - M_RIGHT;
    const plotH = H - M_TOP - M_BOTTOM;
    const t0 = points[0].time.getTime();
    const t1 = points[n - 1].time.getTime();
    const x = (t: number) => M_LEFT + ((t - t0) / (t1 - t0)) * plotW;

    // --- teplotní osa ---
    const temps = points.map((p) => p.temp).filter((v): v is number => v != null);
    let tMin = Math.min(...temps);
    let tMax = Math.max(...temps);
    if (tMax - tMin < 2) {
      tMin -= 1;
      tMax += 1;
    }
    const tStep = niceStep(tMax - tMin, 5);
    tMin = Math.floor(tMin / tStep) * tStep;
    tMax = Math.ceil(tMax / tStep) * tStep;
    const yT = (v: number) => M_TOP + ((tMax - v) / (tMax - tMin)) * plotH;

    // --- srážková osa (min. rozsah 2 mm, ať mrholení nevypadá jako liják) ---
    const pMaxData = Math.max(...points.map((p) => p.precip));
    const pStep = niceStep(Math.max(2, pMaxData), 4);
    const pMax = Math.max(2, Math.ceil(pMaxData / pStep) * pStep);
    const yP = (v: number) => M_TOP + plotH - (Math.min(v, pMax) / pMax) * plotH;

    const fmt = new Intl.NumberFormat(this._lang, { maximumFractionDigits: 0 });
    const fmtP = new Intl.NumberFormat(this._lang, { maximumFractionDigits: 1 });
    const dayFmt = new Intl.DateTimeFormat(this._lang, { weekday: "short" });
    const attrs = this._hass?.states[this._config!.entity]?.attributes;
    const tempUnit = (attrs?.temperature_unit as string | undefined) ?? "°C";
    const precipUnit = (attrs?.precipitation_unit as string | undefined) ?? "mm";

    const parts: unknown[] = [];

    // vodorovná mřížka + popisky teploty (vlevo)
    for (let v = tMin; v <= tMax + 1e-9; v += tStep) {
      const y = yT(v);
      const isZero = Math.abs(v) < 1e-9;
      parts.push(svg`
        <line x1=${M_LEFT} x2=${M_LEFT + plotW} y1=${y} y2=${y}
              class=${isZero ? "grid zero" : "grid"} />
        <line x1=${M_LEFT - 4} x2=${M_LEFT} y1=${y} y2=${y} class="axisline temp-axisline" />
        <text x=${M_LEFT - 8} y=${y + 3.5} class="lbl temp-lbl" text-anchor="end">
          ${fmt.format(v)}
        </text>
      `);
    }

    // popisky srážek (vpravo)
    for (let v = 0; v <= pMax + 1e-9; v += pStep) {
      const y = yP(v);
      parts.push(svg`
        <line x1=${M_LEFT + plotW} x2=${M_LEFT + plotW + 4} y1=${y} y2=${y} class="axisline precip-axisline" />
        <text x=${M_LEFT + plotW + 8} y=${y + 3.5}
              class="lbl precip-lbl" text-anchor="start">
          ${fmtP.format(v)}
        </text>
      `);
    }

    // svislé osy + jednotky
    parts.push(svg`
      <line x1=${M_LEFT} x2=${M_LEFT} y1=${M_TOP} y2=${M_TOP + plotH} class="axisline temp-axisline" />
      <line x1=${M_LEFT + plotW} x2=${M_LEFT + plotW} y1=${M_TOP} y2=${M_TOP + plotH} class="axisline precip-axisline" />
      <text x=${M_LEFT - 8} y=${M_TOP - 10} class="unit temp-lbl" text-anchor="end">${tempUnit}</text>
      <text x=${M_LEFT + plotW + 8} y=${M_TOP - 10} class="unit precip-lbl" text-anchor="start">${precipUnit}</text>
    `);

    // sloupce srážek
    const stepPx = plotW / (n - 1);
    const barW = Math.max(1.5, stepPx * 0.66);
    for (const p of points) {
      if (p.precip < 0.05) continue;
      const y = yP(p.precip);
      parts.push(svg`
        <rect x=${x(p.time.getTime()) - barW / 2} y=${y}
              width=${barW} height=${M_TOP + plotH - y} class="bar" rx="1" />
      `);
    }

    // hranice dnů + popisky dnů a hodin
    for (const p of points) {
      const hr = p.time.getHours();
      const px = x(p.time.getTime());
      if (hr === 0) {
        parts.push(svg`
          <line x1=${px} x2=${px} y1=${M_TOP} y2=${M_TOP + plotH} class="daysep" />
          <text x=${px + 4} y=${H - 6} class="lbl day-lbl" text-anchor="start">
            ${dayFmt.format(p.time)}
          </text>
        `);
      }
      if (hr % 6 === 0 && px >= M_LEFT - 1 && px <= M_LEFT + plotW + 1) {
        parts.push(svg`
          <text x=${px} y=${H - 24} class="lbl hour-lbl" text-anchor="middle">${hr}h</text>
        `);
      }
    }

    // teplotní křivka
    const curve = points
      .filter((p) => p.temp != null)
      .map((p) => [x(p.time.getTime()), yT(p.temp!)] as [number, number]);
    parts.push(svg`<path d=${smoothPath(curve)} class="temp-line" />`);

    // čára "teď"
    const now = Date.now();
    if (now >= t0 && now <= t1) {
      const px = x(now);
      parts.push(svg`
        <line x1=${px} x2=${px} y1=${M_TOP - 4} y2=${M_TOP + plotH} class="nowline" />
      `);
    }

    // kurzor vybrané hodiny
    const selIdx = Math.min(this._selIdx ?? this._nowIdx(points), n - 1);
    const sel = points[selIdx];
    const selX = x(sel.time.getTime());
    parts.push(svg`
      <line x1=${selX} x2=${selX} y1=${M_TOP - 4} y2=${M_TOP + plotH} class="cursorline" />
      ${sel.temp != null ? svg`<circle cx=${selX} cy=${yT(sel.temp)} r="4" class="cursordot" />` : nothing}
    `);

    return html`
      <div class="chart-wrap">
        <svg
          viewBox="0 0 ${W} ${H}"
          width=${W}
          height=${H}
          role="img"
          aria-label="Meteogram: teplota a srážky po hodinách"
          @pointerdown=${this._onPointerDown}
          @pointermove=${this._onPointerMove}
          @pointerup=${this._onPointerUp}
          @pointercancel=${this._onPointerUp}
        >
          ${parts}
        </svg>
        ${this._renderBubble(sel.raw, sel.time, selX, W)}
      </div>
    `;
  }

  private _renderBubble(
    f: ForecastItem,
    time: Date,
    selX: number,
    W: number
  ): TemplateResult {
    const lang = this._lang;
    const attrs = this._hass?.states[this._config!.entity]?.attributes;
    const tempUnit = (attrs?.temperature_unit as string | undefined) ?? "°C";
    const precipUnit = (attrs?.precipitation_unit as string | undefined) ?? "mm";
    const windUnit = (attrs?.wind_speed_unit as string | undefined) ?? "m/s";
    const pressureUnit = (attrs?.pressure_unit as string | undefined) ?? "hPa";

    const fmt1 = new Intl.NumberFormat(lang, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    const fmt0 = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 });
    const when =
      time.toLocaleDateString(lang, {
        day: "numeric",
        month: "long",
        year: "numeric",
      }) +
      " " +
      time.toLocaleTimeString(lang, { hour: "numeric", minute: "2-digit" });

    const icon = CONDITION_ICONS[f.condition ?? ""] ?? "mdi:weather-partly-cloudy";

    // Bublina se překlápí na druhou stranu čáry u okrajů
    const left =
      selX <= W / 2
        ? Math.min(selX + 10, W - BUBBLE_W - 4)
        : Math.max(selX - BUBBLE_W - 10, 4);

    const wind =
      f.wind_speed != null
        ? `${fmt1.format(f.wind_speed)}${
            f.wind_gust_speed != null
              ? ` (${fmt1.format(f.wind_gust_speed)})`
              : ""
          } ${windUnit}`
        : null;

    return html`
      <div class="bubble" style=${styleMap({ left: `${left}px` })}>
        <div class="b-when">${when}</div>
        <div class="b-main">
          <ha-icon class="b-cond" icon=${icon}></ha-icon>
          <span class="b-temp">
            ${f.temperature != null ? fmt1.format(f.temperature) : "–"}<span
              class="b-temp-unit"
              >${tempUnit}</span
            >
          </span>
        </div>
        <div class="b-grid">
          <span class="b-item">
            <ha-icon icon="mdi:water"></ha-icon>
            ${fmt1.format(f.precipitation ?? 0)} ${precipUnit}
          </span>
          ${wind
            ? html`<span class="b-item">
                <ha-icon
                  icon="mdi:arrow-up"
                  class="b-wind"
                  style=${styleMap({
                    transform: `rotate(${((f.wind_bearing ?? 0) + 180) % 360}deg)`,
                  })}
                ></ha-icon>
                ${wind}
              </span>`
            : nothing}
          ${f.pressure != null
            ? html`<span class="b-item">
                <ha-icon icon="mdi:gauge"></ha-icon>
                ${fmt1.format(f.pressure)} ${pressureUnit}
              </span>`
            : nothing}
          ${f.humidity != null
            ? html`<span class="b-item">
                <ha-icon icon="mdi:water-percent"></ha-icon>
                ${fmt0.format(f.humidity)} %
              </span>`
            : nothing}
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
    }
    ha-card {
      overflow: hidden;
    }
    .header {
      background: var(--chmu-header-color, #2167ae);
      color: var(--chmu-header-text-color, #fff);
      font-size: 16px;
      font-weight: 500;
      line-height: 1.2;
      padding: 12px 16px;
      border-radius: var(--ha-card-border-radius, 12px)
        var(--ha-card-border-radius, 12px) 0 0;
    }
    .chart {
      padding: 4px 0 6px;
    }
    .chart-wrap {
      position: relative;
    }
    .msg {
      padding: 24px 16px;
      color: var(--secondary-text-color);
    }
    .msg.error {
      color: var(--error-color, #b00020);
    }
    svg {
      display: block;
      cursor: crosshair;
      touch-action: pan-y;
    }
    .grid {
      stroke: var(--divider-color, #e0e0e0);
      stroke-width: 1;
    }
    .grid.zero {
      stroke: var(--secondary-text-color, #727272);
      stroke-width: 1;
    }
    .daysep {
      stroke: var(--secondary-text-color, #9e9e9e);
      stroke-width: 1;
      opacity: 0.55;
    }
    .axisline {
      stroke-width: 1.5;
    }
    .temp-axisline {
      stroke: var(--chmu-temp-color, #d32f2f);
    }
    .precip-axisline {
      stroke: var(--chmu-precip-axis-color, #4fb3cf);
    }
    .bar {
      fill: var(--chmu-precip-color, #86bfe8);
      opacity: 0.9;
    }
    .temp-line {
      fill: none;
      stroke: var(--chmu-temp-color, #d32f2f);
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .nowline {
      stroke: var(--primary-text-color, #212121);
      stroke-width: 1.5;
      stroke-dasharray: 5 4;
      opacity: 0.75;
    }
    .cursorline {
      stroke: var(--chmu-cursor-color, #5b6f9d);
      stroke-width: 1.5;
      stroke-dasharray: 6 4;
    }
    .cursordot {
      fill: var(--card-background-color, #fff);
      stroke: var(--chmu-temp-color, #d32f2f);
      stroke-width: 2;
    }
    .bubble {
      position: absolute;
      top: 6px;
      width: ${BUBBLE_W}px;
      box-sizing: border-box;
      background: var(--card-background-color, #fff);
      border-radius: 10px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
      padding: 10px 12px;
      pointer-events: none;
      font-family: var(--mdc-typography-font-family, Roboto, sans-serif);
      color: var(--primary-text-color, #212121);
    }
    .b-when {
      font-size: 12px;
      color: var(--secondary-text-color, #727272);
      margin-bottom: 4px;
    }
    .b-main {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .b-cond {
      --mdc-icon-size: 34px;
      color: var(--chmu-header-color, #2167ae);
    }
    .b-temp {
      font-size: 24px;
      font-weight: 700;
    }
    .b-temp-unit {
      font-size: 13px;
      font-weight: 600;
      vertical-align: super;
    }
    .b-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 8px;
      font-size: 12px;
    }
    .b-item {
      display: flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    .b-item ha-icon {
      --mdc-icon-size: 15px;
      color: var(--chmu-header-color, #2167ae);
    }
    .b-wind {
      transition: transform 0.2s;
    }
    .lbl {
      font: 11px var(--mdc-typography-font-family, Roboto, sans-serif);
      fill: var(--secondary-text-color, #727272);
    }
    .unit {
      font: 600 11px var(--mdc-typography-font-family, Roboto, sans-serif);
    }
    .temp-lbl {
      fill: var(--chmu-temp-color, #d32f2f);
    }
    .precip-lbl {
      fill: var(--chmu-precip-axis-color, #4fb3cf);
    }
    .hour-lbl {
      fill: var(--secondary-text-color, #727272);
    }
    .day-lbl {
      font-weight: 700;
      fill: var(--primary-text-color, #212121);
    }
  `;
}

// ---------------------------------------------------------------------------
// Editor (GUI konfigurace)
// ---------------------------------------------------------------------------

interface SchemaItem {
  name: string;
  selector: Record<string, unknown>;
}

const EDITOR_SCHEMA: SchemaItem[] = [
  { name: "entity", selector: { entity: { domain: "weather" } } },
  {
    name: "hours",
    selector: {
      number: { min: MIN_HOURS, max: MAX_HOURS, step: 1, mode: "slider" },
    },
  },
  { name: "title", selector: { text: {} } },
  { name: "show_header", selector: { boolean: {} } },
];

const EDITOR_LABELS: Record<string, string> = {
  entity: "Weather entita (ČHMÚ)",
  hours: "Časový rozsah (hodin)",
  title: "Nadpis",
  show_header: "Zobrazit modrou hlavičku",
};

@customElement("chmu-meteogram-card-editor")
export class ChmuMeteogramCardEditor extends LitElement {
  @state() private _config?: CardConfig;

  public hass?: HomeAssistant;

  setConfig(config: CardConfig): void {
    this._config = config;
  }

  render(): TemplateResult | typeof nothing {
    if (!this._config) return nothing;
    const data = {
      hours: DEFAULT_HOURS,
      show_header: true,
      ...this._config,
    };
    return html`
      <ha-form
        .hass=${this.hass}
        .data=${data}
        .schema=${EDITOR_SCHEMA}
        .computeLabel=${(s: SchemaItem) => EDITOR_LABELS[s.name] ?? s.name}
        @value-changed=${this._valueChanged}
      ></ha-form>
    `;
  }

  private _valueChanged(ev: CustomEvent): void {
    const value = { ...this._config, ...ev.detail.value } as CardConfig;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: value },
        bubbles: true,
        composed: true,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Registrace do výběru karet
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    customCards?: Array<Record<string, unknown>>;
  }
}

window.customCards = window.customCards ?? [];
window.customCards.push({
  type: "chmu-meteogram-card",
  name: "ČHMÚ Meteogram Card",
  description:
    "Hodinový meteogram (teplota + srážky) z integrace ha-chmu-meteogram.",
  preview: true,
  documentationURL: "https://github.com/hruskin/ha-chmu-meteogram-card",
});
