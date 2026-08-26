/*!
 * Dev Circle — onboarding form embed
 *
 * Two lines on somebody else's page:
 *
 *   <div data-devcircle-onboarding="THE_FORM_TOKEN"></div>
 *   <script src="https://circle.creditdirect.ng/embed/onboarding.js" async></script>
 *
 * ─── Why an iframe ─────────────────────────────────────────
 * The obvious alternative is to inject the form into the host page directly.
 * That is worse in three ways that all matter here:
 *
 *   · The form is themed. Rendered inside the host document it inherits their
 *     stylesheet, and a brand-matched form becomes whatever their reset says a
 *     button looks like. Every serious embed ends up shipping a reset to fight
 *     the page it is on, and losing.
 *   · The form collects personal details. In the host document, any script on
 *     that page can read what is being typed into it. In a frame on our own
 *     origin, none can — the same-origin policy is doing the work that a
 *     promise about third-party scripts otherwise would.
 *   · Answers are checked against a definition. Loading the schema, the
 *     renderer and the theme engine into a page we do not control means
 *     colliding with whatever else is on it.
 *
 * What an iframe costs is height: it does not size to its content. So the
 * document inside reports how tall it is and this script resizes the frame —
 * which is the whole of what follows.
 *
 * Nothing here reads or writes cookies, and nothing is sent anywhere except
 * between this script and the frame it created.
 */
(function () {
  'use strict';

  // Where this script was served from is where the form lives. Read from the
  // script's own src rather than configured separately, so a staging embed
  // cannot end up pointing at production because somebody copied a snippet.
  var self = document.currentScript;
  if (!self) {
    // async or deferred scripts lose document.currentScript, so fall back to
    // finding ourselves by name.
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].src && all[i].src.indexOf('/embed/onboarding.js') !== -1) { self = all[i]; break; }
    }
  }
  if (!self) return;

  var base = self.src.replace(/\/embed\/onboarding\.js.*$/, '');
  var origin;
  try { origin = new URL(base).origin; } catch (e) { return; }

  var ATTR = 'data-devcircle-onboarding';
  var mounted = [];

  function mount(holder) {
    var token = holder.getAttribute(ATTR);
    if (!token || holder.getAttribute('data-devcircle-mounted')) return;
    holder.setAttribute('data-devcircle-mounted', '1');

    var frame = document.createElement('iframe');

    // The parent origin is passed in so the document inside knows who to talk
    // to. It cannot be used to talk to anyone else: postMessage will not
    // deliver to an origin that is not actually the parent's.
    frame.src = base + '/o/' + encodeURIComponent(token) +
                '?parent=' + encodeURIComponent(window.location.origin);

    frame.title = holder.getAttribute('data-title') || 'Onboarding form';
    frame.loading = 'lazy';

    // Everything the form needs and nothing else. Without allow-same-origin
    // the framed document would be given an opaque origin and lose the ability
    // to call the API it exists to call; the other three are what a form is:
    // it runs script, it submits, and a link in it opens where the visitor
    // expects. Notably absent: allow-top-navigation, so nothing inside this
    // frame can navigate the page it is embedded on.
    frame.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-popups');

    frame.style.cssText = 'width:100%;border:0;display:block;overflow:hidden;' +
      'height:' + (parseInt(holder.getAttribute('data-height'), 10) || 520) + 'px;' +
      'transition:height .18s ease-out;';

    holder.appendChild(frame);
    mounted.push({ holder: holder, frame: frame });
  }

  function scan() {
    var holders = document.querySelectorAll('[' + ATTR + ']');
    for (var i = 0; i < holders.length; i++) mount(holders[i]);
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== origin) return;

    var data = event.data;
    if (!data || data.source !== 'devcircle-onboarding') return;

    // Which of our frames sent this. Matching on the source window rather than
    // on a token in the message means a page with two forms on it cannot have
    // one resize the other, and a message forged from elsewhere on our origin
    // matches nothing.
    var entry = null;
    for (var i = 0; i < mounted.length; i++) {
      if (mounted[i].frame.contentWindow === event.source) { entry = mounted[i]; break; }
    }
    if (!entry) return;

    if (data.type === 'height' && typeof data.height === 'number') {
      // Bounded, because a height arriving from a document is still a number
      // this page is being asked to trust with its layout.
      var height = Math.max(120, Math.min(data.height, 20000));
      entry.frame.style.height = height + 'px';
    }

    if (data.type === 'submitted') {
      // The host page's own hook: hide the section, show a confirmation, send
      // an analytics event. Cancelable so a page that wants to handle the
      // redirect itself can.
      var forwarded = new CustomEvent('devcircle:onboarding:submitted', {
        bubbles: true, cancelable: true, detail: { redirect: data.redirect || null }
      });

      if (entry.holder.dispatchEvent(forwarded) && data.redirect) {
        // Navigating from here rather than from inside the frame: the frame
        // has no permission to move this page, and would only replace itself —
        // leaving the visitor looking at a page inside a box.
        window.setTimeout(function () { window.location.href = data.redirect; }, 1200);
      }
    }
  }, false);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }

  // Placeholders added after this ran — a form inside a tab, a modal, or
  // anything rendered by the host page's own framework.
  if (window.MutationObserver) {
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  }

  // Named so a host page can mount one it created itself.
  window.DevCircleOnboarding = { scan: scan };
})();
