// Listing dynamic page (HousesforSale item page).
// - Hides the video player when the listing's village has no YouTube video.
// - Opens the Contact Us lightbox from three click targets, passing the
//   property address via memory storage.
// - Pre-fills the contact form (#multiStepForm1) with the logged-in member's
//   profile details: #input10 First Name, #input11 Last Name, #input12 Email,
//   #input13 Phone.

import wixWindow from 'wix-window';
import { memory } from 'wix-storage';
import wixData from 'wix-data';
import { currentMember } from 'wix-members-frontend';

// --- Vacant land display -----------------------------------------------
// Land listings have no bed/bath/living-area, so the stat strip shows
// blanks and zeros. For homeType 'Land' we collapse those elements and,
// if a lot-size text element exists, show the lotSize field instead
// (e.g. '1.24-acre lot').
//
// REPLACE the placeholder IDs below with the real ones from the editor:
// click the element on the page and read its ID from the top of the
// Properties & Events panel. Add or remove entries as needed - if the
// bd/ba/sqft stats live inside one group, its single group ID is enough.
const LAND_HIDE_IDS = ['#REPLACE_bedsText', '#REPLACE_bathsText', '#REPLACE_sqftText'];
// Optional: a text element to display the lot size on land listings.
// Leave as-is (or '') if you don't add one.
const LAND_LOT_SIZE_ID = '#REPLACE_lotSizeText';

function collapseIfPresent(id) {
    try {
        const el = $w(id);
        if (el && el.collapse) { el.hide(); el.collapse(); }
    } catch (err) { /* element not on this page - placeholder not yet replaced */ }
}

function setTextIfPresent(id, text) {
    try {
        const el = $w(id);
        if (el && 'text' in el) { el.text = text; el.expand && el.expand(); }
    } catch (err) { /* element not on this page - optional */ }
}

$w.onReady(function () {
    $w("#dynamicDataset").onReady(() => {
        let currentItem = $w('#dynamicDataset').getCurrentItem();

        if (currentItem.homeType === 'Land') {
            for (const id of LAND_HIDE_IDS) collapseIfPresent(id);
            if (currentItem.lotSize) setTextIfPresent(LAND_LOT_SIZE_ID, currentItem.lotSize);
        }

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

    // Existing click handlers
    $w('#group3').onClick(() => {
        let propertyAddress = $w('#dynamicDataset').getCurrentItem().propertyAddress;
        memory.setItem("key_property_address", propertyAddress);
        wixWindow.openLightbox("Contact Us Lightbox");
    });

    $w('#text126').onClick(() => {
        let propertyAddress = $w('#dynamicDataset').getCurrentItem().propertyAddress;
        memory.setItem("key_property_address", propertyAddress);
        wixWindow.openLightbox("Contact Us Lightbox");
    });

    $w('#button6').onClick(() => {
        let propertyAddress = $w('#dynamicDataset').getCurrentItem().propertyAddress;
        memory.setItem("key_property_address", propertyAddress);
        wixWindow.openLightbox("Contact Us Lightbox");
    });
});

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
