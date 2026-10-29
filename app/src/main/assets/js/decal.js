/* The etched glass.
 *
 * Acid-etched glass is not a line drawing: the shape is frosted solid and the
 * veins are cut into it, which is why an outline version of this read as
 * "clip art" and this one reads as glass. Filled shapes also give the dark
 * theme's translucent panels something to refract, which is the whole point
 * of them.
 *
 * One file, injected into both pages, because there is no build step here and
 * the alternative was the same 30 lines of SVG drifting apart in two places.
 * The colours come from --decal-fill / --decal-line, so each page's own theme
 * decides how loud it is: tinted on a pale ground, where white would vanish,
 * white on black, where it sings.
 */
(function () {
  var SHAPES =
    '<defs>' +
    // One petal, rotated five times into a flower.
    '<g id="dk-pt"><path d="M0,0 C-13,-16 -11,-42 0,-54 C11,-42 13,-16 0,0 Z"/></g>' +
    // A leaf: the blade, a midrib, and the ribs running off it.
    '<g id="dk-lf">' +
    '<path d="M0,0 C16,-11 42,-10 60,4 C42,18 16,20 0,8 Z"/>' +
    '<path d="M2,5 C20,3 40,5 58,5" fill="none"/>' +
    '<path d="M14,1 L20,5 M26,0 L31,5 M38,1 L43,5 M14,13 L20,6 M26,14 L31,6 M38,13 L43,6"' +
    ' fill="none" stroke-width=".9"/>' +
    '</g>' +
    '<g id="dk-bd"><path d="M0,0 C-7,-9 -6,-24 0,-31 C6,-24 7,-9 0,0 Z"/>' +
    '<path d="M0,-4 L0,-26" fill="none" stroke-width=".9"/></g>' +
    '<g id="dk-bl">' +
    '<use href="#dk-pt" transform="rotate(-62)"/><use href="#dk-pt" transform="rotate(-31)"/>' +
    '<use href="#dk-pt"/><use href="#dk-pt" transform="rotate(31)"/>' +
    '<use href="#dk-pt" transform="rotate(62)"/>' +
    '<path d="M0,-20 L0,-44 M-9,-18 L-16,-38 M9,-18 L16,-38" fill="none" stroke-width=".9"/>' +
    '</g>' +
    '</defs>';

  // The stem is drawn thicker than the veins: a branch, not a wire.
  var BRANCH =
    '<path d="M250,556 C236,470 206,404 168,352 C130,300 100,244 86,170" fill="none" stroke-width="3.4"/>' +
    '<path d="M168,352 C196,330 232,322 266,330" fill="none" stroke-width="3.4"/>' +
    '<path d="M130,274 C104,256 76,250 48,256" fill="none" stroke-width="3.4"/>' +
    '<g transform="translate(120,250) rotate(196) scale(.85)"><use href="#dk-lf"/></g>' +
    '<g transform="translate(150,322) rotate(-28)"><use href="#dk-lf"/></g>' +
    '<g transform="translate(168,352) rotate(150) scale(1.1)"><use href="#dk-lf"/></g>' +
    '<g transform="translate(196,392) rotate(18) scale(.95)"><use href="#dk-lf"/></g>' +
    '<g transform="translate(48,256) rotate(-56)"><use href="#dk-bd"/></g>' +
    '<g transform="translate(252,452) rotate(28) scale(.9)"><use href="#dk-bd"/></g>' +
    '<g transform="translate(86,170) rotate(-12) scale(1.05)"><use href="#dk-bl"/></g>' +
    '<g transform="translate(266,330) rotate(66) scale(.9)"><use href="#dk-bl"/></g>';

  function sheet(cls, withDefs) {
    return (
      '<svg class="' + cls + '" viewBox="0 0 400 560" stroke-linecap="round" ' +
      'stroke-linejoin="round" stroke-width="1.3">' +
      (withDefs ? SHAPES : '') + BRANCH + '</svg>'
    );
  }

  function draw() {
    if (document.querySelector('.decal')) return;
    var box = document.createElement('div');
    box.className = 'decal';
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = sheet('d1', true) + sheet('d2', false);
    document.body.insertBefore(box, document.body.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', draw);
  } else {
    draw();
  }

  /**
   * The tab bar gets out of the way when you scroll down for something, and
   * comes back the moment you scroll up for it.
   *
   * It floats over the page so that moving between the three screens is always
   * one tap, which is right - but it was also permanently covering the last
   * couple of lines of whatever you were reading. Sliding it out on the way
   * down keeps both: nothing is hidden while you are reading, and the bar is
   * never more than a flick away.
   */
  function hideOnScroll() {
    const bar = document.querySelector('.tabs');
    if (!bar) return;
    let last = window.scrollY;
    let ticking = false;

    const update = () => {
      ticking = false;
      const y = Math.max(0, window.scrollY);
      const bottom = y + window.innerHeight >= document.documentElement.scrollHeight - 24;
      // A few pixels of slack, or the bar flickers on the small jitters a
      // finger makes while it is resting on a moving page.
      if (bottom || y < 140 || y < last - 6) bar.classList.remove('away');
      else if (y > last + 6) bar.classList.add('away');
      last = y;
    };

    addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      },
      { passive: true }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideOnScroll);
  } else {
    hideOnScroll();
  }
})();
