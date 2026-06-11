import wixData from 'wix-data';

const DATASET_ID = "#dataset1";

const HOMES_COLLECTION_ID = "HousesforSale";
const NEIGHBORHOODS_COLLECTION_ID = "HousesforSale-DynamicPages";

// HousesforSale fields
const PRICE_FIELD = "listingPriceSort"; // tag field
const HOME_TYPE_FIELD = "homeType";     // text field
const BEDROOMS_FIELD = "bedrooms";      // number field
const GARAGES_FIELD = "garages";        // text field
const VILLAGE_FIELD = "village";        // text field

// HousesforSale-DynamicPages fields
const NEIGHBORHOOD_TITLE_FIELD = "title";
const AMENITIES_FIELD = "amenitiesTags"; // tag field

// Canonical price ranges, matching the interactive map and the sync
// pipeline's priceBucket(). Controls dropdown order; tags not in this
// list sort last.
const PRICE_TAG_ORDER = [
  "Under $500k",
  "$500k - $1M",
  "$1M - $2M",
  "$2M - $5M",
  "$5M - $10M",
  "$10M - $15M",
  "$15M+"
];

$w.onReady(async function () {
  const homes = await getAllItems(HOMES_COLLECTION_ID);
  const neighborhoods = await getAllItems(NEIGHBORHOODS_COLLECTION_ID);

  setupPriceDropdown("#dropdown2", homes, PRICE_FIELD);
  setupTextDropdown("#dropdown7", homes, HOME_TYPE_FIELD, "All");
  setupNumberDropdown("#dropdown4", homes, BEDROOMS_FIELD, "All");
  setupAmenitiesDropdown("#dropdown5", neighborhoods, AMENITIES_FIELD);
  setupTextDropdown("#dropdown6", homes, GARAGES_FIELD, "All", garageSortValue);
  setupTextDropdown("#dropdown1", homes, VILLAGE_FIELD, "All");

  $w("#dropdown2").onChange(applyFilters);
  $w("#dropdown7").onChange(applyFilters);
  $w("#dropdown4").onChange(applyFilters);
  $w("#dropdown5").onChange(applyFilters);
  $w("#dropdown6").onChange(applyFilters);
  $w("#dropdown1").onChange(applyFilters);

  applyFilters();
});

function setupPriceDropdown(dropdownId, items, fieldId) {
  const allTags = [];

  items.forEach(item => {
    const value = item[fieldId];

    if (Array.isArray(value)) {
      value.forEach(tag => {
        if (tag) {
          allTags.push(String(tag).trim());
        }
      });
    } else if (value) {
      allTags.push(String(value).trim());
    }
  });

  const uniqueTags = [...new Set(allTags)]
    .sort((a, b) => priceSortValue(a) - priceSortValue(b));

  $w(dropdownId).options = [
    { label: "All", value: "All" },
    ...uniqueTags.map(tag => ({
      label: tag,
      value: tag
    }))
  ];

  $w(dropdownId).value = "All";
}

function setupTextDropdown(dropdownId, items, fieldId, allLabel = "All", sortFunction = null) {
  const values = [];

  items.forEach(item => {
    const value = item[fieldId];

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      values.push(String(value).trim());
    }
  });

  let uniqueValues = [...new Set(values)];

  if (sortFunction) {
    uniqueValues = uniqueValues.sort((a, b) => sortFunction(a) - sortFunction(b));
  } else {
    uniqueValues = uniqueValues.sort((a, b) => a.localeCompare(b));
  }

  $w(dropdownId).options = [
    { label: allLabel, value: "All" },
    ...uniqueValues.map(value => ({
      label: value,
      value: value
    }))
  ];

  $w(dropdownId).value = "All";
}

function setupNumberDropdown(dropdownId, items, fieldId, allLabel = "All") {
  const values = [];

  items.forEach(item => {
    const value = item[fieldId];

    if (value !== undefined && value !== null && value !== "") {
      values.push(Number(value));
    }
  });

  const uniqueValues = [...new Set(values)]
    .filter(value => !isNaN(value))
    .sort((a, b) => a - b);

  $w(dropdownId).options = [
    { label: allLabel, value: "All" },
    ...uniqueValues.map(value => ({
      label: String(value),
      value: String(value)
    }))
  ];

  $w(dropdownId).value = "All";
}

function setupAmenitiesDropdown(dropdownId, neighborhoods, fieldId) {
  const allTags = [];

  neighborhoods.forEach(item => {
    const tags = item[fieldId];

    if (Array.isArray(tags)) {
      tags.forEach(tag => {
        if (tag) {
          allTags.push(String(tag).trim());
        }
      });
    }
  });

  const uniqueTags = [...new Set(allTags)]
    .sort((a, b) => a.localeCompare(b));

  $w(dropdownId).options = [
    { label: "All", value: "All" },
    ...uniqueTags.map(tag => ({
      label: tag,
      value: tag
    }))
  ];

  $w(dropdownId).value = "All";
}

async function applyFilters() {
  let filter = wixData.filter();

  const selectedPrice = $w("#dropdown2").value;
  const selectedHomeType = $w("#dropdown7").value;
  const selectedBedrooms = $w("#dropdown4").value;
  const selectedAmenity = $w("#dropdown5").value;
  const selectedGarage = $w("#dropdown6").value;
  const selectedVillage = $w("#dropdown1").value;

  if (selectedPrice && selectedPrice !== "All") {
    filter = filter.hasSome(PRICE_FIELD, [selectedPrice]);
  }

  if (selectedHomeType && selectedHomeType !== "All") {
    filter = filter.eq(HOME_TYPE_FIELD, selectedHomeType);
  }

  if (selectedBedrooms && selectedBedrooms !== "All") {
    filter = filter.eq(BEDROOMS_FIELD, Number(selectedBedrooms));
  }

  if (selectedGarage && selectedGarage !== "All") {
    filter = filter.eq(GARAGES_FIELD, selectedGarage);
  }

  if (selectedVillage && selectedVillage !== "All") {
    filter = filter.eq(VILLAGE_FIELD, selectedVillage);
  }

  if (selectedAmenity && selectedAmenity !== "All") {
    const matchingNeighborhoodNames = await getNeighborhoodNamesForAmenity(selectedAmenity);

    if (matchingNeighborhoodNames.length > 0) {
      const amenityVillageFilter = buildVillageOrFilter(matchingNeighborhoodNames);
      filter = filter.and(amenityVillageFilter);
    } else {
      // Force no results if no neighborhoods match the selected amenity
      filter = filter.eq("_id", "NO_MATCH_FOUND");
    }
  }

  $w(DATASET_ID).setFilter(filter)
    .catch(err => {
      console.error("Error applying filters:", err);
    });
}

async function getNeighborhoodNamesForAmenity(selectedAmenity) {
  let matchingNames = [];
  let skip = 0;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const results = await wixData.query(NEIGHBORHOODS_COLLECTION_ID)
      .hasSome(AMENITIES_FIELD, [selectedAmenity])
      .limit(limit)
      .skip(skip)
      .find();

    results.items.forEach(item => {
      const title = item[NEIGHBORHOOD_TITLE_FIELD];

      if (title) {
        matchingNames.push(String(title).trim());
      }
    });

    if (results.items.length < limit) {
      hasMore = false;
    } else {
      skip += limit;
    }
  }

  return [...new Set(matchingNames)];
}

function buildVillageOrFilter(villageNames) {
  let villageFilter = wixData.filter().eq(VILLAGE_FIELD, villageNames[0]);

  for (let i = 1; i < villageNames.length; i++) {
    villageFilter = villageFilter.or(
      wixData.filter().eq(VILLAGE_FIELD, villageNames[i])
    );
  }

  return villageFilter;
}

async function getAllItems(collectionId) {
  let allItems = [];
  let skip = 0;
  const limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const results = await wixData.query(collectionId)
      .limit(limit)
      .skip(skip)
      .find();

    allItems = allItems.concat(results.items);

    if (results.items.length < limit) {
      hasMore = false;
    } else {
      skip += limit;
    }
  }

  return allItems;
}

function priceSortValue(value) {
  const index = PRICE_TAG_ORDER.indexOf(String(value).trim());
  return index === -1 ? PRICE_TAG_ORDER.length : index;
}

function garageSortValue(value) {
  if (!value) {
    return 999;
  }

  const cleaned = String(value).toLowerCase().trim();

  if (cleaned.includes("no") || cleaned.includes("none") || cleaned.includes("0")) {
    return 0;
  }

  const match = cleaned.match(/\d+/);
  return match ? Number(match[0]) : 999;
}
