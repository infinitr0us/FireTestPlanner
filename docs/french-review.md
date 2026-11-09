# French interface review

The Canadian French catalogue is a draft pending review by a francophone fire
safety engineer. It ships in v0.8.0 marked as a draft; the review is deferred until a
French-speaking user of the tool can give feedback (decided 2026-11-02). The supplied
glossary is the baseline. No glossary entry was deliberately rejected. Review these
terms in their engineering context:

| English term | Draft French | Where | Alternatives or question for the reviewer |
|---|---|---|---|
| heat release rate (HRR) | taux de dégagement de chaleur (TDC) | Burner, checks, curves, report | Confirm the lab's preferred acronym; some source files retain HRR as a recorded name. |
| thermocouple bead | jonction | Rakes, temperature checks, set-out | jonction de mesure; confirm whether sensor construction requires a more specific term. |
| thermocouple rake / tree | arbre de thermocouples | Palette, inspector, report | peigne de thermocouples for a linear assembly; supplied glossary retained. |
| thin-skin calorimeter | calorimètre à peau mince | Gauge kind, equipment list | calorimètre à paroi mince; confirm the instrument family's usual Canadian name. |
| plate thermometer | thermomètre à plaque | Gauge kind, checks | thermomètre à plaque métallique; supplied glossary retained. |
| frustum | pyramide de vision | Camera optics and help | tronc de pyramide de vision when a near clipping plane matters. |
| soffit | sous-face | Ceiling inspector, FDS checks, report | face inférieure; confirm crew vocabulary. |
| set-out / set-out check | implantation / vérification d’implantation | Drawing tables | piquetage, relevé d’implantation; confirm suitability for indoor apparatus. |
| standoff (plan / slant) | distance (plan / oblique) | Camera inspector, set-out, coverage | distance horizontale / distance directe; confirm the distinction is clear. |
| range / over range | étendue / hors étendue | Gauge checks and plots | plage de mesure / dépassement de plage; distinguish sensor capacity from plotted limits. |
| hood capture / spill | captage / débordement | Hood checks and report | collecte / échappement; confirm for calorimetry rather than ventilation alone. |
| Flame analysis… (toolbar) | Flamme… | Toolbar | Analyse de flamme… is the closer term, but with a plan's title beside it the French toolbar needs a third row at 1280 x 720; the tooltip and the board's own title keep Analyse de flamme. |
| onset (of a fire event) | début | Flame analysis board: readout, plots | apparition, déclenchement; confirm for a battery vent jet. |
| close-up / whole picture | gros plan / image entière | Flame analysis camera tiles | |
| as built / pose | tel que construit / pose | Survey overlay and inspector | relevé réel / position et orientation; confirm wording for movable instruments. |
| lattice pitch | pas du réseau | Reconstructed-flame diagnostics | pas de grille; distinguish spacing from voxel size. |
| boundary patch | zone de frontière | FDS result errors | portion de paroi; keep the FDS output family distinct from a physical wall. |

## Implementation and review boundary

`web/src/ui/i18n-fr.ts` uses English source text as keys. Add messages with literal
keys in `t()` or two literal keys in `plural()`. Interpolation uses named braces;
pass user content as parameters. Numbers are localized only at display boundaries.
French uses a decimal comma and a narrow no-break space before composed units and
percent signs. English file serialization, FDS text and schedule CSV stay unchanged.

The unit-test catalogue guard parses all production TypeScript under `web/src`
using the parser already supplied by Vite. It follows named import aliases and
namespace imports, collects string and static-template keys and both plural forms,
and fails on parse errors, dynamic keys, detached translators, namespace
destructuring and translation re-exports. It also compares placeholder sets.
The shipped camera notes have a separate coverage test so a changed seed note
cannot silently fall back. Key collection verifies wrapped calls; reviewing new
visible text for wrapping remains part of UI review.

Product and model names, user names and notes, source metadata, filenames, paths,
FDS quantities and keywords, schema field names, identifiers, check codes, unit
symbols and machine-readable exports remain verbatim. This includes English notes
already stored in imported or example plans. Raw operating-system, browser and
third-party parser error details are retained inside translated editor messages.
Native file-picker text follows the operating system. Internal undo operation names
remain English; they are not displayed by the editor.

The shell settings route stores the interface language alongside camera presets,
independently of any plan. `python/fireplan` is unchanged. Browser storage failures
leave the switch usable for the session. Desktop settings persistence has a Python
regression test; native WebView2 interaction and OS dialogs require a desktop check.

## Layout and interaction

The toolbar fits in two rows at 1280 × 720 in both languages: the three FDS
commands share an **FDS** menu. The palette uses two columns of tiles with the icon
beside the label, in both languages, so words such as « combustible » and
« thermocouple » are never split across lines. Panel section headings can wrap beside their actions;
long filenames and user text can wrap within their panels. The rail retains its
existing independent scroll areas and Checks allocation.

The browser regression switches using real EN/FR clicks at 1280 × 720, checks the
toolbar, palette, inspector, diagnostics, drawing set-out heading, document language,
storage restoration in a new tab, container widths and palette word wrapping.
Generated screenshots and logs belong in ignored `review/`.
