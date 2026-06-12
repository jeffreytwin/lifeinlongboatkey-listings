// Snippet for the listing dynamic page (HousesforSale item page).
// Paste at the END of the page's existing code - it registers its own
// $w.onReady alongside whatever the page already does.
//
// Pre-fills the contact form (#multiStepForm1) with the logged-in member's
// profile details. Anonymous visitors get the empty form. Elements:
//   #input10 First Name, #input11 Last Name, #input12 Email, #input13 Phone

import { currentMember } from 'wix-members-frontend';

$w.onReady(async function () {
  try {
    const member = await currentMember.getMember({ fieldsets: ['FULL'] });
    if (!member) return; // not logged in

    const contact = member.contactDetails || {};
    const phone = Array.isArray(contact.phones) && contact.phones.length
      ? contact.phones[0]
      : null;

    setIfEmpty('#input10', contact.firstName);   // First Name
    setIfEmpty('#input11', contact.lastName);    // Last Name
    setIfEmpty('#input12', member.loginEmail);   // Email
    setIfEmpty('#input13', phone);               // Phone
  } catch (err) {
    console.error('Contact form prefill failed:', err);
  }
});

// Only fill blank fields so we never clobber something the visitor
// already typed (e.g. after navigating between listings).
function setIfEmpty(elementId, value) {
  if (!value) return;
  const field = $w(elementId);
  if (field && !field.value) {
    field.value = value;
  }
}
