// Home page.
// Pulses the Get Started button (#button3) on load — two size breathes with
// an orange color throb, matching the Get Started flash on the interactive
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
// Velo-only button pulse: two size breathes with a matching color throb,
// then the button settles back to its normal color.
//
// The normal color is read from the button at runtime when Wix exposes it;
// FALLBACK_NORMAL_COLOR only applies when that read comes back empty, so set
// it to the button's actual fill color from the editor (click #button3 and
// check its Design panel) to be safe.
// ---------------------------------------------------------------------------
function startPulse(buttonId) {
    const FALLBACK_NORMAL_COLOR = '#0E5254'; // <-- match #button3's design fill color
    const PULSE_COLOR = '#E6A039'; // golden orange — same as the interactive map
    const PULSES = 2;

    try {
        const button = $w(buttonId);
        const NORMAL_COLOR = button.style.backgroundColor || FALLBACK_NORMAL_COLOR;

        // Each visual pulse is one scale-up plus one scale-down (yoyo),
        // so 2 pulses = 4 timeline runs = the first run + 3 repeats.
        timeline({ repeat: PULSES * 2 - 1, yoyo: true })
            .add(button, { scale: 1.06, duration: 700, easing: 'easeInOutSine' })
            .play();

        // Color throbs on the same 700ms beat, ending on the normal color.
        let tick = 0;
        const colorTimer = setInterval(() => {
            tick += 1;
            button.style.backgroundColor = (tick % 2 === 1) ? PULSE_COLOR : NORMAL_COLOR;
            if (tick >= PULSES * 2) {
                clearInterval(colorTimer);
                button.style.backgroundColor = NORMAL_COLOR;
            }
        }, 700);
    } catch (err) {
        console.error(`Pulse setup failed for ${buttonId}:`, err);
    }
}
