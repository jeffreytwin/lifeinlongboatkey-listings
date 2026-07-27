// Amenities page - communities repeater with amenity/price filters.
//
// Perf notes: the previous version of this page awaited a full fetch of the
// HousesforSale-DynamicPages collection (every field of every row) inside
// $w.onReady just to build the two filter dropdowns. That blocked rendering
// for ~5s, which made Wix's server-side render time out and ship a blank
// page (no <title>, no content) that then had to re-run the same fetch in
// the browser. This version keeps onReady synchronous: the dataset paints
// its first 9 items untouched, and the dropdowns are populated after render,
// in the browser only, from a query trimmed to the two tag fields.
//
// Element IDs assumed to exist on the page: #dataset2, #dropdown1 (amenity),
// #dropdown2 (price), #button2 (Load more).
//
// IMPORTANT editor setting: #dataset2's "Number of items to display" must be
// set to 9 (= PAGE_SIZE). The previous code forced 9 at runtime on every
// load, hiding a too-high editor value; without that clamp the editor value
// shows through, and it also controls how many panels SSR has to render.

import wixData from 'wix-data';
import wixWindow from 'wix-window';

const DATASET_ID = "#dataset2";
const COLLECTION_ID = "HousesforSale-DynamicPages";

const AMENITY_TAG_FIELD = "amenitiesTags";
const PRICE_TAG_FIELD = "priceRangeTags";

const PAGE_SIZE = 9; // communities shown before "Load more"

// Canonical price ranges, matching the Homes for Sale page. Controls the
// dropdown options + order; only buckets that have matching data are shown.
const PRICE_TAG_ORDER = [
  "Under $500k",
  "$500k - $1M",
  "$1M - $2M",
  "$2M - $5M",
  "$5M - $10M",
  "$10M - $15M",
  "$15M+"
];

// Built by setupPriceDropdown: bucket label -> raw priceRangeTags values
// that fall in that bucket. Selecting a bucket filters by all of them.
let priceTagsByBucket = {};

$w.onReady(function () {
  // Nothing in here may await data work: this function runs during Wix's
  // server-side render, and blocking it is what blanked the page.

  $w("#dropdown1").onChange(() => {
    applyFilters();
  });

  $w("#dropdown2").onChange(() => {
    applyFilters();
  });

  // Load more: reveal all remaining results, then hide the button.
  $w("#button2").onClick(() => {
    const total = $w(DATASET_ID).getTotalCount();
    $w(DATASET_ID).setPageSize(total > PAGE_SIZE ? total : PAGE_SIZE)
      .then(() => {
        $w("#button2").collapse();
      })
      .catch((err) => {
        console.error("Error loading more communities:", err);
      });
  });

  // The dataset loads its own first page - don't reset or refilter it
  // during SSR. The dataset's "Number of items to display" must be 9 in
  // the editor settings: that setting decides how many panels the server
  // renders. The old code masked a too-high setting by forcing 9 on every
  // load; the browser-only clamp below self-corrects it (one extra fetch),
  // but fixing the editor setting is what keeps the server render light.
  $w(DATASET_ID).onReady(() => {
    if (wixWindow.rendering.env === "browser" && $w(DATASET_ID).getPageSize() > PAGE_SIZE) {
      $w(DATASET_ID).setPageSize(PAGE_SIZE)
        .then(() => {
          updateLoadMoreButton();
        })
        .catch((err) => {
          console.error("Error resetting page size:", err);
        });
    } else {
      updateLoadMoreButton();
    }
  });

  // Dropdown options are only usable once a visitor can interact, so build
  // them after render and only in the browser - never during SSR.
  if (wixWindow.rendering.env === "browser") {
    populateFilterDropdowns().catch((err) => {
      console.error("Error building filter dropdowns:", err);
    });
  }
});

async function populateFilterDropdowns() {
  const tagRows = await getAllTagRows();
  setupAmenityDropdown(tagRows);
  setupPriceDropdown(tagRows);
}

// Fetch every row's two tag fields (and nothing else). fields() keeps the
// payload tiny; if your wix-data version doesn't support it, removing that
// line still works, just heavier.
async function getAllTagRows() {
  let results = await wixData.query(COLLECTION_ID)
    .fields(AMENITY_TAG_FIELD, PRICE_TAG_FIELD)
    .limit(1000)
    .find();

  let allItems = results.items;

  while (results.hasNext()) {
    results = await results.next();
    allItems = allItems.concat(results.items);
  }

  return allItems;
}

function setupAmenityDropdown(allItems) {
  const allAmenityTags = [];

  allItems.forEach(item => {
    const tags = item[AMENITY_TAG_FIELD];

    if (Array.isArray(tags)) {
      tags.forEach(tag => {
        if (tag) {
          allAmenityTags.push(tag);
        }
      });
    }
  });

  const uniqueAmenityTags = [...new Set(allAmenityTags)].sort();

  $w("#dropdown1").options = [
    { label: "All", value: "All" },
    ...uniqueAmenityTags.map(tag => ({
      label: tag,
      value: tag
    }))
  ];

  $w("#dropdown1").value = "All";
}

function setupPriceDropdown(allItems) {
  // Group every raw price tag into its canonical bucket.
  priceTagsByBucket = {};

  allItems.forEach(item => {
    const tags = item[PRICE_TAG_FIELD];

    if (Array.isArray(tags)) {
      tags.forEach(tag => {
        if (!tag) {
          return;
        }

        const raw = String(tag).trim();
        const bucket = priceBucketLabel(priceTagToNumber(raw));

        if (!priceTagsByBucket[bucket]) {
          priceTagsByBucket[bucket] = [];
        }
        if (!priceTagsByBucket[bucket].includes(raw)) {
          priceTagsByBucket[bucket].push(raw);
        }
      });
    }
  });

  // Show the canonical buckets, in order, but only those that have data.
  const buckets = PRICE_TAG_ORDER.filter(bucket => priceTagsByBucket[bucket]);

  $w("#dropdown2").options = [
    { label: "All", value: "All" },
    ...buckets.map(bucket => ({
      label: bucket,
      value: bucket
    }))
  ];

  $w("#dropdown2").value = "All";
}

function applyFilters() {
  let filter = wixData.filter();

  const selectedAmenity = $w("#dropdown1").value;
  const selectedPrice = $w("#dropdown2").value;

  if (selectedAmenity && selectedAmenity !== "All") {
    filter = filter.hasSome(AMENITY_TAG_FIELD, [selectedAmenity]);
  }

  if (selectedPrice && selectedPrice !== "All") {
    // Match every raw price tag that falls in the selected bucket.
    const rawTags = priceTagsByBucket[selectedPrice] || [selectedPrice];
    filter = filter.hasSome(PRICE_TAG_FIELD, rawTags);
  }

  // Reset to the first page of 9 whenever the filters change, then apply
  // the filter and update the Load more button based on the total.
  $w(DATASET_ID).setPageSize(PAGE_SIZE)
    .then(() => $w(DATASET_ID).setFilter(filter))
    .then(() => {
      updateLoadMoreButton();
    })
    .catch((err) => {
      console.error("Error applying filters:", err);
    });
}

function updateLoadMoreButton() {
  const total = $w(DATASET_ID).getTotalCount();

  if (total > PAGE_SIZE) {
    $w("#button2").expand();
  } else {
    $w("#button2").collapse();
  }
}

// Map a numeric price to one of the canonical PRICE_TAG_ORDER buckets.
function priceBucketLabel(numericValue) {
  if (numericValue < 500000) return "Under $500k";
  if (numericValue < 1000000) return "$500k - $1M";
  if (numericValue < 2000000) return "$1M - $2M";
  if (numericValue < 5000000) return "$2M - $5M";
  if (numericValue < 10000000) return "$5M - $10M";
  if (numericValue < 15000000) return "$10M - $15M";
  return "$15M+";
}

function priceTagToNumber(tag) {
  if (!tag) {
    return 0;
  }

  const cleaned = String(tag)
    .replace("$", "")
    .replace(/,/g, "")
    .trim()
    .toLowerCase();

  if (cleaned.endsWith("s")) {
    return Number(cleaned.replace("s", "")) * 1000;
  }

  if (cleaned.endsWith("m")) {
    return Number(cleaned.replace("m", "")) * 1000000;
  }

  return Number(cleaned) || 0;
}
