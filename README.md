# ČHMÚ Meteogram Card

Lovelace karta pro Home Assistant, která vykresluje hodinový meteogram
(teplota + srážky) ve stylu mobilní aplikace **Počasí ČHMÚ**.

Data bere z weather entity integrace
[ha-chmu-meteogram](https://github.com/hruskin/ha-chmu-meteogram)
(model ALADIN, ČHMÚ) — funguje ale s libovolnou weather entitou,
která podporuje hodinovou předpověď (`weather/subscribe_forecast`).

- 🌡️ teplota — červená vyhlazená křivka, levá osa
- 🌧️ srážky — světle modré sloupce, pravá osa (mm)
- 🕐 osa X po hodinách (`0h / 6h / 12h / 18h`), zkratky dnů na půlnočních
  zlomech (`st`, `čt`, …)
- ⏱️ přerušovaná svislá čára „teď"
- ↔️ posuvník — graf jde posouvat přes celou předpověď (jako v aplikaci ČHMÚ)
- 🔧 nastavitelné viditelné okno 6–73 hodin
- 🎨 modrá hlavička, barvy přizpůsobitelné přes CSS proměnné, GUI editor

## Instalace

### HACS (doporučeno)

1. HACS → tři tečky → **Custom repositories**
2. Repository: `https://github.com/hruskin/ha-chmu-meteogram-card`,
   typ: **Dashboard**
3. Nainstaluj **ČHMÚ Meteogram Card** a obnov stránku

### Ručně

Zkopíruj `chmu-meteogram-card.js` z [poslední release](../../releases)
do `config/www/` a přidej resource:

```yaml
url: /local/chmu-meteogram-card.js
type: module
```

## Konfigurace

```yaml
type: custom:chmu-meteogram-card
entity: weather.chmu_praha_predpoved
hours: 48
```

| Volba         | Typ     | Výchozí                 | Popis                                            |
| ------------- | ------- | ----------------------- | ------------------------------------------------ |
| `entity`      | string  | **povinné**             | Weather entita s hodinovou předpovědí            |
| `hours`       | number  | `48`                    | Kolik hodin je vidět najednou (6–73)             |
| `scrollbar`   | boolean | `true`                  | Posuvník — posun grafu přes celou předpověď; při `false` se zobrazí jen prvních `hours` hodin |
| `title`       | string  | friendly name entity    | Text v hlavičce                                  |
| `show_header` | boolean | `true`                  | Zobrazit modrou hlavičku                         |

Kartu lze plně nastavit i v GUI editoru dashboardu.

### Barvy (volitelné, přes [card-mod](https://github.com/thomasloven/lovelace-card-mod) nebo theme)

| CSS proměnná                  | Výchozí   | Význam                  |
| ----------------------------- | --------- | ----------------------- |
| `--chmu-header-color`         | `#2167ae` | pozadí hlavičky         |
| `--chmu-temp-color`           | `#d32f2f` | teplotní křivka + osa   |
| `--chmu-precip-color`         | `#86bfe8` | sloupce srážek          |
| `--chmu-precip-axis-color`    | `#4fb3cf` | srážková osa + popisky  |
| `--chmu-scrollbar-color`      | `#5b6f9d` | jezdec posuvníku        |
| `--chmu-scrollbar-track-color`| `#e3e6ec` | dráha posuvníku         |

## Vývoj

```bash
npm install
npm run build      # dist/chmu-meteogram-card.js
npm run watch      # rebuild při změně
npm run typecheck
```

## Licence

Apache-2.0 — viz [LICENSE](LICENSE).
Data: ČHMÚ (data-provider.chmi.cz), model ALADIN.
