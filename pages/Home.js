// Home page.
// Pulses the Get Started button (#button3) on load — two size breathes with
// an orange color fade, matching the Get Started flash on the interactive
// map and the #button9 pulse on the listing dynamic page. Velo-only, no CSS.
//
// The homepage previously had no page code; this file is its entire code
// panel. The button's link/click behavior is set in the editor and is not
// touched here.

import { timeline } from 'wix-animations';

$w.onReady(function () {
    startPulse('#button3');
});

// ---------------------------------------------------------------------------
// Velo-only button pulse. The scale breathes via wix-animations; the color
// ramps in lockstep on a short timer — fading toward orange while the button
// grows and back to its normal color while it shrinks, with the same
// easeInOutSine feel as the scale. Ends settled on the normal color.
//
// The normal color is read from the button at runtime when Wix exposes it;
// FALLBACK_NORMAL_COLOR only applies when that read comes back empty or
// unparseable, so set it to the button's actual fill color from the editor
// (click #button3 and check its Design panel) to be safe.
// ---------------------------------------------------------------------------
function startPulse(buttonId) {
    const FALLBACK_NORMAL_COLOR = '#49C3A9'; // <-- match #button3's design fill color
    const PULSE_COLOR = '#E6A039'; // golden orange — same as the interactive map
    const PULSES = 2;
    const BEAT_MS = 700; // one leg of a pulse: the grow, or the shrink
    const STEP_MS = 40;  // color-ramp resolution (~25 fps)

    try {
        const button = $w(buttonId);
        const normal = parseColor(button.style.backgroundColor) || parseColor(FALLBACK_NORMAL_COLOR);
        const pulse = parseColor(PULSE_COLOR);

        // Each visual pulse is one scale-up plus one scale-down (yoyo),
        // so 2 pulses = 4 timeline runs = the first run + 3 repeats.
        timeline({ repeat: PULSES * 2 - 1, yoyo: true })
            .add(button, { scale: 1.06, duration: BEAT_MS, easing: 'easeInOutSine' })
            .play();

        const totalLegs = PULSES * 2;
        let elapsed = 0;
        const colorTimer = setInterval(() => {
            elapsed += STEP_MS;
            const leg = Math.floor(elapsed / BEAT_MS);
            if (leg >= totalLegs) {
                clearInterval(colorTimer);
                button.style.backgroundColor = mixColors(normal, pulse, 0);
                return;
            }
            let f = (elapsed % BEAT_MS) / BEAT_MS;    // progress within this leg
            if (leg % 2 === 1) f = 1 - f;             // shrink legs fade back down
            f = 0.5 - 0.5 * Math.cos(Math.PI * f);    // easeInOutSine, matches the scale
            button.style.backgroundColor = mixColors(normal, pulse, f);
        }, STEP_MS);
    } catch (err) {
        console.error(`Pulse setup failed for ${buttonId}:`, err);
    }
}

// Accepts '#RGB', '#RRGGBB', 'rgb(r, g, b)', or 'rgba(r, g, b, a)' and
// returns [r, g, b], or null for anything it can't read (e.g. a gradient).
function parseColor(color) {
    if (!color) return null;
    const s = String(color).trim();
    const hex = s.match(/^#?([0-9a-f]{6})$/i);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const short = s.match(/^#?([0-9a-f]{3})$/i);
    if (short) return short[1].split('').map((c) => parseInt(c + c, 16));
    const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return null;
}

// Blend two [r, g, b] colors; f=0 is all `from`, f=1 is all `to`.
function mixColors(from, to, f) {
    const ch = (i) => Math.round(from[i] + (to[i] - from[i]) * f);
    return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}
