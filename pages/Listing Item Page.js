import wixWindow from 'wix-window';
import wixLocation from 'wix-location';
import { memory } from 'wix-storage';
import wixData from 'wix-data';
import { currentMember } from 'wix-members-frontend';
import { timeline } from 'wix-animations';

// ---------------------------------------------------------------------------
// Interactive-map tile config — replaces the old Google Maps element.
// >>> Paste your public Mapbox token below before publishing. <<<
// ---------------------------------------------------------------------------
const MAPBOX_TOKEN = 'PASTE_MAPBOX_PUBLIC_TOKEN_HERE'; // public token (pk....) — set in the Wix page only; never commit the real value
const MAP_TILE_ID = '#maptile';                          // the Image element's ID
const INTERACTIVE_MAP_BASE = 'https://map.lifeinlongboatkey.com/';
const VILLAGE_NAME_FIELD = 'title';                      // village name in HousesforSale-DynamicPages
// ---------------------------------------------------------------------------
const LBK_CENTER = { lng: -82.63640, lat: 27.38476 };    // mid-key fallback center
const TILE = { w: 600, h: 300, zoom: 16, pin: 'E47A5C' }; // 2:1 tile; 0E5254 = brand teal

// Stat-strip elements that only make sense for a built home. On Land
// listings these hide and #text118 becomes the single "Land" label.
const LAND_HIDE_IDS = ['#text119', '#line2', '#text120', '#text121', '#line3', '#text122', '#text123'];

$w.onReady(function () {
    $w("#dynamicDataset").onReady(() => {
        let currentItem = $w('#dynamicDataset').getCurrentItem();

        // Show #text385 only when this listing's village is in Bay Isles.
        updateBayIslesText(currentItem);

        // Land listings: relabel the stat strip and hide the empty stats.
        updateLandDisplay(currentItem);

        // Stamp the hidden form fields with this listing's details.
        prefillListingFields(currentItem);

        // Build the branded map tile + deep link for this listing.
        setupPropertyMapTile(currentItem);

        // If village1 is already joined (an object), check it directly.
        if (currentItem.village1 && typeof currentItem.village1 === 'object') {
            if (!currentItem.village1.youTubeVideo) {
                $w('#videoPlayer1').hide();
                $w('#videoPlayer1').collapse();
            }
        }
        // If village1 is just an ID, retrieve the full referenced record.
        else if (currentItem.village1) {
            wixData.get("HousesforSale-DynamicPages", currentItem.village1)
                .then((villageItem) => {
                    if (!villageItem.youTubeVideo) {
                        $w('#videoPlayer1').hide();
                        $w('#videoPlayer1').collapse();
                    }
                })
                .catch((err) => {
                    console.error("Error fetching village item:", err);
                });
        }
        // In case village1 is missing
        else {
            $w('#videoPlayer1').hide();
            $w('#videoPlayer1').collapse();
        }
    });

    prefillContactForm();

    // Pulse the Join Interest List button (Velo-only version, no CSS needed).
    startPulse('#button9');

    // Lightbox openers: stash the full listing context in memory first so
    // the lightbox form can prefill every field, not just the address.
    const openContactLightbox = () => {
        stashListingContext();
        wixWindow.openLightbox("Contact Us Lightbox");
    };
    const openInterestListLightbox = () => {
        stashListingContext();
        wixWindow.openLightbox("Join Interest List");
    };

    $w('#group3, #button6, #button7, #button8, #text126').onClick(openContactLightbox);
    $w('#button9').onClick(openInterestListLightbox);
});

// ---------------------------------------------------------------------------
// Land listings: vacant land has no bed/bath/living-area stats, so the strip
// shows blanks and zeros. When homeType is 'Land', the stat texts and divider
// lines hide. #text118 is form-factor dependent: on mobile it stays visible
// as the single 'Land' label; on desktop (and tablet) it hides with the rest.
// hide() keeps each element's space so the strip's layout doesn't shift;
// swap in .collapse() as well if you'd rather the gap close up.
// ---------------------------------------------------------------------------
function updateLandDisplay(currentItem) {
    if (!currentItem) return;
    if (String(currentItem.homeType || '').trim().toLowerCase() !== 'land') return;

    try {
        if (wixWindow.formFactor === 'Mobile') {
            $w('#text118').text = 'Land';
        } else {
            $w('#text118').hide();
        }
    } catch (err) {
        console.error('Land label update failed for #text118:', err);
    }

    for (const id of LAND_HIDE_IDS) {
        try {
            $w(id).hide();
        } catch (err) {
            console.error(`Hide failed for ${id}:`, err);
        }
    }
}

// ---------------------------------------------------------------------------
// Velo-only button pulse: two size breathes with a matching color throb,
// then the button settles back to its normal color. Set NORMAL_COLOR to the
// button's actual fill color from the editor.
// ---------------------------------------------------------------------------
function startPulse(buttonId) {
    const NORMAL_COLOR = '#49C3A9'; // <-- your green — match the button's design color
    const PULSE_COLOR = '#E6A039'; // golden orange
    const PULSES = 2;

    try {
        // Each visual pulse is one scale-up plus one scale-down (yoyo),
        // so 2 pulses = 4 timeline runs = the first run + 3 repeats.
        timeline({ repeat: PULSES * 2 - 1, yoyo: true })
            .add($w(buttonId), { scale: 1.06, duration: 700, easing: 'easeInOutSine' })
            .play();

        // Color throbs on the same 700ms beat, ending on the normal color.
        let tick = 0;
        const colorTimer = setInterval(() => {
            tick += 1;
            $w(buttonId).style.backgroundColor = (tick % 2 === 1) ? PULSE_COLOR : NORMAL_COLOR;
            if (tick >= PULSES * 2) {
                clearInterval(colorTimer);
                $w(buttonId).style.backgroundColor = NORMAL_COLOR;
            }
        }, 700);
    } catch (err) {
        console.error(`Pulse setup failed for ${buttonId}:`, err);
    }
}

// ---------------------------------------------------------------------------
// Bay Isles text: resolve the village name from the village1 reference
// (object or ID, same pattern as the video check), falling back to the
// plain village text field, then show/hide #text385 accordingly.
// ---------------------------------------------------------------------------
async function updateBayIslesText(currentItem) {
    let villageName = "";

    if (currentItem) {
        const v = currentItem.village1;
        if (v && typeof v === 'object') {
            villageName = v[VILLAGE_NAME_FIELD] || "";
        } else if (v) {
            try {
                const villageItem = await wixData.get("HousesforSale-DynamicPages", v);
                villageName = (villageItem && villageItem[VILLAGE_NAME_FIELD]) || "";
            } catch (err) {
                console.error("Village lookup for Bay Isles text failed:", err);
            }
        }

        // Fallback: the village text stored directly on the listing.
        if (!villageName) {
            villageName = currentItem.village || "";
        }
    }

    if (String(villageName).toLowerCase().includes("bay isles")) {
        $w('#text385').show();
        $w('#text385').expand();
    } else {
        $w('#text385').hide();
        $w('#text385').collapse();
    }
}

// Store everything the lightbox form needs. Values are formatted with the
// same helpers as the on-page form so both always show identical text.
function stashListingContext() {
    const item = $w('#dynamicDataset').getCurrentItem();
    if (!item) return;

    memory.setItem("key_property_address", item.propertyAddress || "");
    memory.setItem("key_home_type", item.homeType || "");
    memory.setItem("key_village", item.village || "");
    memory.setItem("key_listing_price", formatPrice(item.listingPrice) || "");
    memory.setItem("key_link", toAbsoluteUrl(item['link-houses-for-sale-propertyAddress']) || "");
}

// ---------------------------------------------------------------------------
// Map tile: render a static, branded map image for this listing and link it
// to the full interactive map, deep-linked to the listing's neighborhood.
// ---------------------------------------------------------------------------
async function setupPropertyMapTile(currentItem) {
    const tile = $w(MAP_TILE_ID);
    if (!tile) return; // element not on the page yet — safe no-op

    try {
        const [coords, slug] = await Promise.all([
            resolveCoords(currentItem),
            resolveNeighborhoodSlug(currentItem),
        ]);

        tile.src = buildStaticMapUrl(coords.lng, coords.lat);

        if (slug) {
            tile.link = `${INTERACTIVE_MAP_BASE}?community=${encodeURIComponent(slug)}`;
            tile.target = '_self';
        }
    } catch (err) {
        console.error('Map tile setup failed:', err);
    }
}

// Prefer stored coordinates; fall back to geocoding the address; finally
// fall back to the LBK center so the tile always shows a map.
async function resolveCoords(currentItem) {
    const lat = Number(currentItem.latitude);
    const lng = Number(currentItem.longitude);
    if (isFinite(lat) && isFinite(lng) && (lat || lng)) return { lat, lng };

    const address = currentItem.propertyAddress;
    if (address) {
        try {
            const q = encodeURIComponent(address);
            const url =
                `https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json` +
                `?limit=1&country=us&proximity=${LBK_CENTER.lng},${LBK_CENTER.lat}` +
                `&access_token=${MAPBOX_TOKEN}`;
            const res = await fetch(url);
            const data = await res.json();
            const c = data && data.features && data.features[0] && data.features[0].center;
            if (c && c.length === 2) return { lng: c[0], lat: c[1] };
        } catch (err) {
            console.error('Geocode failed:', err);
        }
    }
    return LBK_CENTER;
}

// Turn the listing's neighborhood into the interactive-map slug.
async function resolveNeighborhoodSlug(currentItem) {
    // Primary: the village name stored directly on the listing.
    if (currentItem.village) return slugify(currentItem.village);

    // Fallback: the village1 reference, if the direct field is ever empty.
    const v = currentItem.village1;
    if (v && typeof v === 'object') return slugify(v[VILLAGE_NAME_FIELD]);
    if (v) {
        try {
            const villageItem = await wixData.get('HousesforSale-DynamicPages', v);
            return slugify(villageItem && villageItem[VILLAGE_NAME_FIELD]);
        } catch (err) {
            console.error('Village lookup failed:', err);
        }
    }
    return null;
}

// Matches the interactive map's own slug logic (lowercase, non-alphanumeric
// runs → hyphens). "Harbour Circle (Bay Isles)" → "harbour-circle-bay-isles".
function slugify(name) {
    if (!name) return null;
    return String(name).toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function buildStaticMapUrl(lng, lat) {
    return `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/` +
        `pin-l+${TILE.pin}(${lng},${lat})/${lng},${lat},${TILE.zoom}/` +
        `${TILE.w}x${TILE.h}@2x?access_token=${MAPBOX_TOKEN}`;
}

// ---------------------------------------------------------------------------
// Hidden listing fields in #multiStepForm1. Each one is stamped with this
// listing's data so every submission records exactly which property (and
// its key details) the inquiry came from. These set unconditionally — a
// hidden field should always reflect the listing being viewed, never a
// stale value.
// ---------------------------------------------------------------------------
function prefillListingFields(currentItem) {
    if (!currentItem) return;

    setFieldValue('#input14', currentItem.propertyAddress);              // Property Address
    setFieldValue('#hometype', currentItem.homeType);                    // Home Type
    setFieldValue('#village', currentItem.village);                      // Village / Neighborhood
    setFieldValue('#listingprice', formatPrice(currentItem.listingPrice)); // Listing Price
    setFieldValue('#listingurl', toAbsoluteUrl(currentItem['link-houses-for-sale-propertyAddress'])); // Listing URL
}

// Set one form field, skipping empty values and missing elements so a
// listing with a blank column (or a renamed element) never throws.
function setFieldValue(elementId, value) {
    if (value === undefined || value === null || value === '') return;
    try {
        const field = $w(elementId);
        if (field) {
            field.value = String(value);
        }
    } catch (err) {
        console.error(`Prefill failed for ${elementId}:`, err);
    }
}

// listingPrice may be stored as a number or as display text. Numbers get
// formatted as "$1,250,000"; strings pass through untouched.
function formatPrice(price) {
    if (price === undefined || price === null || price === '') return null;
    const n = typeof price === 'number' ? price : Number(String(price).replace(/[$,]/g, ''));
    if (isFinite(n) && n > 0) return '$' + n.toLocaleString('en-US');
    return price;
}

// The link-houses-for-sale-propertyAddress field stores a relative path
// (e.g. "/houses-for-sale/123-gulf-of-mexico-dr"). Prepend the site's base
// URL so the form captures a full, clickable link.
function toAbsoluteUrl(link) {
    if (!link) return null;
    if (/^https?:\/\//i.test(link)) return link;
    const base = wixLocation.baseUrl.replace(/\/$/, '');
    return link.startsWith('/') ? base + link : `${base}/${link}`;
}

// Pre-fill the contact form (#multiStepForm1) with the logged-in member's
// profile details. Anonymous visitors just get the empty form.
async function prefillContactForm() {
    try {
        const member = await currentMember.getMember({ fieldsets: ['FULL'] });
        if (!member) return; // not logged in

        const contact = member.contactDetails;
        const firstName = contact && contact.firstName ? contact.firstName : null;
        const lastName = contact && contact.lastName ? contact.lastName : null;
        const phones = contact && contact.phones ? contact.phones : null;
        const phone = phones && phones.length ? phones[0] : null;
        const email = member.loginEmail ? member.loginEmail : null;

        setIfEmpty('#input10', firstName);   // First Name
        setIfEmpty('#input11', lastName);    // Last Name
        setIfEmpty('#input12', email);       // Email
        setIfEmpty('#input13', phone);       // Phone
    } catch (err) {
        console.error("Contact form prefill failed:", err);
    }
}

// Only fill blank fields so we never clobber something the visitor
// already typed (e.g. after navigating between listings).
function setIfEmpty(elementId, value) {
    if (!value) return;
    const field = $w(elementId);
    if (field && !field.value) {
        field.value = value;
    }
}
