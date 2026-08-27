// ─── Survey themes ──────────────────────────────────────────
// How a survey looks to the member answering it.
//
// A survey goes out under someone's name. A cohort assembled around a partner
// programme, a survey about one product line, a circle that is not Credit
// Direct's in-house research — each has its own brand, and a form that looks
// like none of them is a form people abandon or, worse, distrust. So a theme
// carries the whole surface: canvas and text colours, an accent, type,
// imagery, an opening and a closing, and the shape of its progress.
//
// Colours are set, not merely derived. An earlier version offered an accent
// and worked everything else out from it, which is fine for one house style
// and useless for anyone else's — a brand is a background and a text colour
// before it is anything else. What is derived from those two is the ladder
// between them: card surfaces, borders, muted text. That keeps a themed survey
// coherent without asking an author to pick eleven greys.
//
// Two things are still not on offer, for the same reasons as before.
// Arbitrary CSS: a theme is data, not code, and a stylesheet from an author is
// a stylesheet from anyone who reaches the author's account. And an unreadable
// result: colours are free, but the contrast between them is measured, and a
// combination nobody could read is refused rather than shipped. The common way
// to make a form unusable is to put brand grey on white and never look at it
// on a phone outdoors.
//
// A theme is stored on the survey. A circle carries a default, so a workspace
// looks like itself without every author re-picking it.
//
//   SurveyTheme.normalize(input)      → the theme as stored, issues, warnings
//   SurveyTheme.resolve(survey, circle) → the theme actually in force
//   SurveyTheme.toCSS(theme)          → custom properties to drop on :root

const SurveyTheme = (() => {

  const DEFAULTS = {
    accent: '#107EBC',          // Credit Direct denim blue
    background: 'plain',
    font: 'default',
    corner: 'soft',
    layout: 'one_per_page',
    page_size: 3,               // how many questions a page holds, when the layout is n_per_page
    progress: 'bar',
    mode: 'auto',
    logo_url: null,
    intro: null,
    thank_you: null,

    // Null means "follow the member's light or dark setting". A brand that
    // names its own canvas is saying the survey looks the same either way,
    // which is usually the point of naming it.
    background_color: null,
    text_color: null,
    muted_color: null,          // derived from the other two when not set
    surface_color: null,        // cards and controls; derived when not set

    background_image: null,
    background_fit: 'cover',
    background_overlay: null,   // how hard to dim an image so text survives it
    header_image: null,         // shown above the opening screen

    scale: 'regular',

    // An uploaded typeface, used when font is 'brand'
    brand_font: null,
    brand_font_name: null
  };

  const BACKGROUNDS = ['plain', 'tinted', 'gradient'];
  const FITS = ['cover', 'contain', 'tile'];
  const CORNERS = ['sharp', 'soft', 'round'];
  // one_per_page: one question per screen. all_at_once: the whole survey on
  // one page. n_per_page: a page of `page_size` questions. by_section: a
  // section heading is where a page breaks, and the questions under it stay
  // with it — the point where a section is introduced is the point where the
  // survey page is divided.
  const LAYOUTS = ['one_per_page', 'all_at_once', 'n_per_page', 'by_section'];
  const PAGE_SIZE = { min: 2, max: 10 };
  const PROGRESS = ['bar', 'steps', 'count', 'none'];
  const MODES = ['auto', 'light', 'dark'];

  // The families a survey can be set in — one list of real typefaces, picked
  // by name, the way this decision is made everywhere else. An earlier version
  // offered "pairings" with mood names (Editorial, Geometric) and mapped them
  // onto whatever the reader's device happened to have. That is not a font
  // picker: an author who has been told to use Montserrat cannot choose
  // Montserrat, and two people picking "Geometric" on different machines get
  // different typefaces.
  //
  // Every family here is served from this origin — see assets/css/fonts.css
  // for why — with a system stack behind it for the moment before it loads.
  // Sizes are the Latin subset, since that is what a survey is written in.
  const FONTS = {
    // Kept as the default so a survey that was never themed still looks like
    // the product it came from
    default: { label: 'Dev Circle', category: 'sans', stack: "'Plus Jakarta Sans', 'Inter', system-ui, sans-serif" },

    inter:        { label: 'Inter',             category: 'sans',  stack: "'Inter', system-ui, sans-serif" },
    roboto:       { label: 'Roboto',            category: 'sans',  stack: "'Roboto', system-ui, sans-serif" },
    opensans:     { label: 'Open Sans',         category: 'sans',  stack: "'Open Sans', system-ui, sans-serif" },
    lato:         { label: 'Lato',              category: 'sans',  stack: "'Lato', system-ui, sans-serif" },
    sourcesans:   { label: 'Source Sans 3',     category: 'sans',  stack: "'Source Sans 3', system-ui, sans-serif" },
    worksans:     { label: 'Work Sans',         category: 'sans',  stack: "'Work Sans', system-ui, sans-serif" },
    montserrat:   { label: 'Montserrat',        category: 'sans',  stack: "'Montserrat', system-ui, sans-serif" },
    poppins:      { label: 'Poppins',           category: 'sans',  stack: "'Poppins', system-ui, sans-serif" },
    nunito:       { label: 'Nunito',            category: 'sans',  stack: "'Nunito', system-ui, sans-serif" },
    spacegrotesk: { label: 'Space Grotesk',     category: 'sans',  stack: "'Space Grotesk', system-ui, sans-serif" },

    playfair:     { label: 'Playfair Display',  category: 'serif', stack: "'Playfair Display', Georgia, serif" },
    merriweather: { label: 'Merriweather',      category: 'serif', stack: "'Merriweather', Georgia, serif" },
    lora:         { label: 'Lora',              category: 'serif', stack: "'Lora', Georgia, serif" },
    baskerville:  { label: 'Libre Baskerville', category: 'serif', stack: "'Libre Baskerville', Georgia, serif" },

    plexmono:     { label: 'IBM Plex Mono',     category: 'mono',  stack: "'IBM Plex Mono', ui-monospace, monospace" },

    // ── Families that come from the reader's device, not from us ──
    // These are not served here, because they are not ours to redistribute.
    // They render for whoever already has them and fall back for everyone
    // else, which is a real trade rather than a bug: Corbel ships with Windows
    // and Office, so it will show for most desktop readers in a corporate
    // setting and for almost no one on a phone.
    //
    // `device: true` is what keeps the "every family we offer is actually
    // served" check honest — it excludes these deliberately rather than by
    // forgetting them.
    corbel: {
      label: 'Corbel', category: 'device', device: true,
      note: 'Windows and Office ship it; other devices fall back',
      stack: "Corbel, 'Segoe UI', Candara, Optima, system-ui, sans-serif"
    },
    system: {
      label: 'System default', category: 'device', device: true,
      note: 'Whatever the reader’s device uses — nothing to download',
      stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    },

    brand: {
      label: 'Custom font',
      category: 'custom',
      needsUpload: true,
      // Filled in from the uploaded file at render time. The fallback is what
      // a member sees before it loads, and forever if it fails to.
      stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    }
  };

  // How large the survey is set. A question people read on a phone in the
  // field is a different size from one read at a desk, and it is the single
  // most requested thing after colour.
  const SCALES = { small: 0.92, regular: 1, large: 1.12, larger: 1.25 };

  // The family name a brand font is registered under. Sanitised hard: it is
  // written into a CSS @font-face declaration, so anything that could close
  // the string or the block is simply not part of a font name.
  const familyName = value => trimmed(value)
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim() || 'Brand';

  const CORNER_RADII = { sharp: '2px', soft: '10px', round: '20px' };

  const str = v => (v === null || v === undefined ? '' : String(v));
  const trimmed = v => str(v).trim();

  const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

  function normalizeHex(value) {
    const hex = trimmed(value);
    if (!HEX.test(hex)) return null;
    if (hex.length === 4) {
      return ('#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]).toLowerCase();
    }
    return hex.toLowerCase();
  }

  function rgb(hex) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    };
  }

  // Relative luminance, WCAG's definition. Every legibility decision here is
  // made from it rather than from how a colour looks on the author's monitor.
  function luminance(hex) {
    const { r, g, b } = rgb(hex);
    const channel = v => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // What to write on a filled accent. Not a preference — whichever of black or
  // white the accent can actually carry.
  function onAccent(accent) {
    return contrast(accent, '#ffffff') >= contrast(accent, '#111111') ? '#ffffff' : '#111111';
  }

  function withAlpha(hex, alpha) {
    const { r, g, b } = rgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // Mixing toward white or black rather than shifting hue, so a hover state
  // stays recognisably the same colour.
  function shade(hex, amount) {
    const { r, g, b } = rgb(hex);
    const towards = amount < 0 ? 0 : 255;
    const t = Math.abs(amount);
    const mix = c => Math.round(c + (towards - c) * t);
    const hexPart = c => mix(c).toString(16).padStart(2, '0');
    return `#${hexPart(r)}${hexPart(g)}${hexPart(b)}`;
  }

  // Blend two colours. This is what builds the ladder between a brand's canvas
  // and its text — card surfaces, borders, muted labels — so an author names
  // two colours and gets a coherent surface rather than eleven pickers.
  function mix(from, to, t) {
    const a = rgb(from);
    const b = rgb(to);
    const part = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    return `#${part(a.r, b.r)}${part(a.g, b.g)}${part(a.b, b.b)}`;
  }

  // ─── Legibility ───────────────────────────────────────────
  // Brand colours are the author's to choose. Whether the result can be read
  // is not a matter of taste, so it is measured — and the two are treated
  // differently: below 3:1 nothing can be read and the theme is refused, and
  // between 3:1 and WCAG AA's 4.5:1 it is allowed with a warning, because at
  // that point it is a judgement about a brand rather than a broken page.

  const AA = 4.5;          // WCAG AA for body text
  const FLOOR = 3;         // below this, refuse — no brand is worth an unusable form

  function legibility(theme) {
    const issues = [];
    const warnings = [];

    const background = theme.background_color;
    const text = theme.text_color;
    if (!background || !text) return { issues, warnings };

    const ratio = contrast(text, background);

    if (ratio < FLOOR) {
      issues.push({
        field: 'text_color',
        message: `Text on this background is ${ratio.toFixed(1)}:1 — not readable. It needs at least ${FLOOR}:1.`
      });
    } else if (ratio < AA) {
      warnings.push({
        field: 'text_color',
        message: `Text on this background is ${ratio.toFixed(1)}:1, under the ${AA}:1 needed for comfortable reading.`
      });
    }

    // The accent carries buttons and the progress bar. If it disappears into
    // the canvas the member cannot find the way forward.
    if (theme.accent && contrast(theme.accent, background) < 1.6) {
      warnings.push({
        field: 'accent',
        message: 'The accent is very close to the background, so buttons and progress will be hard to pick out.'
      });
    }

    if (theme.muted_color) {
      const muted = contrast(theme.muted_color, background);
      if (muted < FLOOR) {
        warnings.push({
          field: 'muted_color',
          message: `Secondary text is ${muted.toFixed(1)}:1 against the background and will be hard to read.`
        });
      }
    }

    return { issues, warnings };
  }

  // Images and fonts are uploaded, and what a theme stores is the path they
  // were stored at. Somewhere else is not an option, for three reasons that
  // all point the same way: the content policy this app serves under allows
  // images and fonts from its own origin only, so a remote address would
  // simply not load; a remote address puts every member who opens a survey in
  // front of whoever is hosting it; and a link can start returning something
  // other than what was approved, long after anyone looked.
  //
  // The characters barred below are the ones that would let a path stop being
  // a path. A background image is written into a CSS url(), so a quote, a
  // bracket or a semicolon in it could close that url() and start declaring
  // something else — the same class of problem as an unescaped quote in SQL,
  // and refused rather than escaped and hoped over.
  const CSS_BREAKERS = /["'()\\;{}]|\s/;

  // What an upload looks like once stored, plus the app's own assets, so a
  // theme can point at a wordmark that ships with the product.
  const OWN_ASSET = /^\/(uploads|assets)\/[A-Za-z0-9._\-/]+$/;

  function normalizeAsset(value, field, push) {
    const url = trimmed(value);
    if (!url) return null;
    if (url.length > 300) { push(field, 'That path is too long'); return null; }

    if (CSS_BREAKERS.test(url)) {
      push(field, 'That path contains characters a file path cannot hold');
      return null;
    }

    if (/^https?:\/\//i.test(url) || url.startsWith('//')) {
      push(field, 'Upload the file rather than linking to it — a survey only loads images and fonts from here');
      return null;
    }

    if (url.includes('..')) { push(field, 'That is not a valid path'); return null; }
    if (OWN_ASSET.test(url)) return url;

    push(field, 'Upload a file to use here');
    return null;
  }

  function normalizeCopy(value, { headlineMax = 120, bodyMax = 600, button = false } = {}) {
    if (!value || typeof value !== 'object') return null;
    const copy = {};
    const headline = trimmed(value.headline).slice(0, headlineMax);
    const body = trimmed(value.body).slice(0, bodyMax);
    if (headline) copy.headline = headline;
    if (body) copy.body = body;
    if (button) {
      const label = trimmed(value.button).slice(0, 40);
      if (label) copy.button = label;
    }
    return Object.keys(copy).length ? copy : null;
  }

  function pick(value, allowed, fallback, field, push) {
    const chosen = trimmed(value);
    if (!chosen) return fallback;
    if (allowed.includes(chosen)) return chosen;
    push(field, `"${chosen}" is not one of: ${allowed.join(', ')}`);
    return fallback;
  }

  // Returns the theme as it will be stored, anything the author wrote that
  // could not be honoured, and anything honoured that they should look at
  // again. Only what differs from the default is kept, so a survey that was
  // never themed stores nothing and follows its circle.
  function normalize(input) {
    const issues = [];
    const push = (field, message) => issues.push({ field, message });

    if (!input || typeof input !== 'object') return { theme: null, issues, warnings: [] };

    const theme = {};

    // A named colour, kept only when it says something the default does not
    const colour = (key, field = key) => {
      if (input[key] === undefined || trimmed(input[key]) === '' || input[key] === null) return;
      const value = normalizeHex(input[key]);
      if (!value) { push(field, `A colour must be a hex value like #107EBC`); return; }
      if (DEFAULTS[key] && value === normalizeHex(DEFAULTS[key])) return;
      theme[key] = value;
    };

    // Compared in the same case it is stored in — otherwise the default
    // written back as #107EBC reads as an override of itself
    colour('accent');
    colour('background_color');
    colour('text_color');
    colour('muted_color');
    colour('surface_color');

    const background = pick(input.background, BACKGROUNDS, DEFAULTS.background, 'background', push);
    if (background !== DEFAULTS.background) theme.background = background;

    const brandFont = normalizeAsset(input.brand_font, 'brand_font', push);
    if (brandFont) {
      theme.brand_font = brandFont;
      theme.brand_font_name = familyName(input.brand_font_name);
    }

    const font = trimmed(input.font);
    if (font && !FONTS[font]) {
      push('font', `"${font}" is not one of: ${Object.keys(FONTS).join(', ')}`);
    } else if (font === 'brand' && !theme.brand_font) {
      // Choosing "your own font" without one would silently fall back to a
      // system stack, which reads as the upload having failed
      push('font', 'Upload a font file to use your own typeface');
    } else if (font && font !== DEFAULTS.font) {
      theme.font = font;
    }

    const corner = pick(input.corner, CORNERS, DEFAULTS.corner, 'corner', push);
    if (corner !== DEFAULTS.corner) theme.corner = corner;

    const layout = pick(input.layout, LAYOUTS, DEFAULTS.layout, 'layout', push);
    if (layout !== DEFAULTS.layout) theme.layout = layout;

    // How many questions a page holds. Only the n_per_page layout has pages
    // of a size, and a page of one is the one-per-page layout wearing a
    // costume, while a page of everything is all-on-one-page — so the range
    // excludes both. And N is a number the author sets, not one the app
    // picks: "N per page" without an N is a page size nobody chose, and a
    // page size that lands anyway is a survey that quietly means something
    // other than what was written.
    if (layout === 'n_per_page') {
      const size = parseInt(input.page_size, 10);
      if (!Number.isFinite(size)) {
        push('page_size', `The "N per page" layout needs N — how many questions a page holds (${PAGE_SIZE.min}–${PAGE_SIZE.max})`);
      } else {
        theme.page_size = Math.min(PAGE_SIZE.max, Math.max(PAGE_SIZE.min, size));
      }
    }

    const progress = pick(input.progress, PROGRESS, DEFAULTS.progress, 'progress', push);
    if (progress !== DEFAULTS.progress) theme.progress = progress;

    const mode = pick(input.mode, MODES, DEFAULTS.mode, 'mode', push);
    if (mode !== DEFAULTS.mode) theme.mode = mode;

    const scale = pick(input.scale, Object.keys(SCALES), DEFAULTS.scale, 'scale', push);
    if (scale !== DEFAULTS.scale) theme.scale = scale;

    for (const [key, field] of [['logo_url', 'logo_url'], ['background_image', 'background_image'],
                                ['header_image', 'header_image']]) {
      const asset = normalizeAsset(input[key], field, push);
      if (asset) theme[key] = asset;
    }

    if (theme.background_image) {
      const fit = pick(input.background_fit, FITS, DEFAULTS.background_fit, 'background_fit', push);
      if (fit !== DEFAULTS.background_fit) theme.background_fit = fit;

      // A photograph behind text is the most reliable way to make a survey
      // unreadable, and the reading is on the image rather than on any colour,
      // so it cannot be measured. A scrim is applied by default and the author
      // can lift it, rather than being absent by default and remembered.
      const overlay = input.background_overlay;
      const amount = overlay === undefined || overlay === null || overlay === ''
        ? 0.55
        : Math.min(0.95, Math.max(0, Number(overlay)));
      theme.background_overlay = Number.isFinite(amount) ? amount : 0.55;
    }

    const intro = normalizeCopy(input.intro, { button: true });
    if (intro) theme.intro = intro;

    const thanks = normalizeCopy(input.thank_you);
    if (thanks) theme.thank_you = thanks;

    // Measured against the whole theme in force, not just what this call set:
    // a survey naming only a text colour is read against the canvas it
    // inherits, which is the combination the member will actually see.
    const readable = legibility(resolve(theme));
    issues.push(...readable.issues);

    return {
      theme: Object.keys(theme).length ? theme : null,
      issues,
      warnings: readable.warnings
    };
  }

  // The theme in force: what the survey says, over what its circle says, over
  // the defaults. Merged field by field, so a survey that only sets an accent
  // still inherits its circle's wordmark.
  function resolve(surveyTheme, circleTheme) {
    return { ...DEFAULTS, ...(circleTheme || {}), ...(surveyTheme || {}) };
  }

  // The custom properties that put a theme on screen. Everything derived from
  // the accent is computed here rather than stored, so a theme saved last
  // quarter picks up any change to how a hover or a tint is worked out.
  function toCSS(resolved) {
    const theme = resolve(resolved);
    const accent = normalizeHex(theme.accent) || DEFAULTS.accent;
    const canvas = normalizeHex(theme.background_color);
    const ink = normalizeHex(theme.text_color);

    // With a canvas named, "dark" is a fact about that colour rather than a
    // setting — a brand whose background is near-black is a dark theme
    // whatever the member's own preference says.
    const dark = canvas ? luminance(canvas) < 0.2 : theme.mode === 'dark';

    // An uploaded face leads its own stack, with a system fallback behind it —
    // so the survey is readable in the moment before it loads and stays
    // readable if it never does.
    const family = FONTS[theme.font] || FONTS.default;
    const brand = theme.font === 'brand' && theme.brand_font
      ? `'${familyName(theme.brand_font_name)}', ` : '';
    const stack = brand + family.stack;

    const vars = {
      '--cd-blue': accent,
      '--cd-blue-deep': shade(accent, dark ? 0.18 : -0.18),
      '--cd-blue-40': withAlpha(accent, 0.4),
      '--cd-blue-dim': withAlpha(accent, dark ? 0.16 : 0.08),
      '--on-accent': onAccent(accent),
      // One family throughout. A survey is a form, not a magazine: setting the
      // question in one face and the options in another makes it harder to
      // read, not more designed.
      '--font-display': stack,
      '--font-body': stack,
      '--survey-scale': String(SCALES[theme.scale] || 1),
      '--r-md': CORNER_RADII[theme.corner] || CORNER_RADII.soft,
      '--r-lg': CORNER_RADII[theme.corner] || CORNER_RADII.soft
    };

    // The ladder between the two brand colours. Without this a custom canvas
    // would sit behind cards, borders and muted labels still drawn from the
    // product's own greys, which is worse than no theming at all — it reads as
    // a page that failed to load its stylesheet.
    if (canvas || ink) {
      const ground = canvas || (dark ? '#16162a' : '#f5f2ed');
      const text = ink || (luminance(ground) < 0.4 ? '#ffffff' : '#1a1a2e');
      const surface = normalizeHex(theme.surface_color) || mix(ground, text, dark ? 0.06 : 0.03);
      const muted = normalizeHex(theme.muted_color) || mix(text, ground, 0.32);

      Object.assign(vars, {
        '--surface-0': ground,
        '--surface-1': surface,
        '--surface-2': surface,
        '--surface-3': mix(ground, text, 0.10),
        '--surface-4': mix(ground, text, 0.16),

        '--text': text,
        '--white': text,
        '--text-2': muted,
        '--ash': muted,
        '--text-3': mix(text, ground, 0.5),
        '--ash-dim': mix(text, ground, 0.5),

        '--line-faint': withAlpha(text, 0.07),
        '--line': withAlpha(text, 0.14),
        '--line-strong': withAlpha(text, 0.26),
        '--tint-1': withAlpha(text, 0.04),
        '--tint-2': withAlpha(text, 0.07),
        '--tint-3': withAlpha(text, 0.12)
      });
    }

    // The canvas layer: a tint or wash derived from the accent, an image, or
    // both — the image underneath, the scrim over it, so text keeps its
    // footing on a photograph.
    const layers = [];

    if (theme.background === 'tinted') {
      layers.push(`linear-gradient(${withAlpha(accent, dark ? 0.1 : 0.05)}, ${withAlpha(accent, dark ? 0.1 : 0.05)})`);
    } else if (theme.background === 'gradient') {
      layers.push(`linear-gradient(160deg, ${withAlpha(accent, dark ? 0.22 : 0.12)} 0%, transparent 55%)`);
    }

    if (theme.background_image) {
      const ground = canvas || (dark ? '#16162a' : '#f5f2ed');
      const scrim = withAlpha(ground, theme.background_overlay ?? 0.55);
      layers.push(`linear-gradient(${scrim}, ${scrim})`);
      layers.push(
        theme.background_fit === 'tile'
          ? `url(${theme.background_image}) top left / auto repeat`
          : `url(${theme.background_image}) center / ${theme.background_fit || 'cover'} no-repeat fixed`
      );
    }

    if (layers.length) vars['--survey-canvas'] = layers.join(', ');

    return vars;
  }

  const toCSSText = theme =>
    Object.entries(toCSS(theme)).map(([k, v]) => `${k}: ${v};`).join(' ');

  // The @font-face a brand font needs, or nothing. Kept apart from toCSS
  // because custom properties go on an element and this has to go in a
  // stylesheet — the two have different homes even though they are one
  // decision.
  //
  // `swap` on purpose: a member reading a question in a fallback face for a
  // moment is better than reading nothing at all while a download finishes,
  // and on a slow Nigerian mobile connection that difference is the survey.
  function fontFace(resolved) {
    const theme = resolve(resolved);
    if (theme.font !== 'brand' || !theme.brand_font) return '';

    const format = /\.woff2$/i.test(theme.brand_font) ? 'woff2'
      : /\.woff$/i.test(theme.brand_font) ? 'woff'
      : /\.otf$/i.test(theme.brand_font) ? 'opentype' : 'truetype';

    return `@font-face {
      font-family: '${familyName(theme.brand_font_name)}';
      src: url(${theme.brand_font}) format('${format}');
      font-display: swap;
    }`;
  }

  return {
    DEFAULTS, FONTS, SCALES, BACKGROUNDS, CORNERS, LAYOUTS, PAGE_SIZE, PROGRESS, MODES, FITS, CORNER_RADII,
    AA, FLOOR,
    normalize, resolve, toCSS, toCSSText, fontFace, legibility,
    normalizeHex, onAccent, contrast, luminance, shade, mix, withAlpha, familyName
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SurveyTheme;
