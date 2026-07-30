# /amenities speed findings (2026-07-30)

## Speed test that prompted this

| metric | value |
| --- | --- |
| Time To First Byte | 5.085s |
| First Contentful Paint | 16.584s |
| Total Requests | 204 |
| Page Weight | 2MB |
| Cumulative Layout Shift | 0 |

## What the live page source proves

Pulled from `view-source:https://www.lifeinlongboatkey.com/amenities`:

1. `ssrInfo.renderBodyTime: 4696` - Wix's server spent ~4.7s rendering the
   page body. That is nearly the entire 5.1s TTFB.
2. `window.clientSideRender = true`, an **empty** `<div id="SITE_CONTAINER">`,
   and **no `<title>` tag** in the head - the server render was abandoned and
   a blank shell was shipped. The browser then downloads the whole Wix
   runtime (the bulk of the 204 requests) and rebuilds the page from nothing
   before anything paints. That is the 16.6s FCP.
3. `cacheExclusionReason: "Site member has data binding"` - Wix never caches
   this site's server renders (site members + CMS datasets), so **every**
   visitor pays the full server render. Keeping that render light is the only
   lever; there is no cache to hide behind.

Chain: slow SSR (4.7s) -> SSR gives up -> blank HTML -> client rebuilds
everything -> 16.6s first paint.

## Page code status

The Velo code on the page (tracked in `pages/Amenities.js`) is already the
right shape: `$w.onReady` stays synchronous, the filter dropdowns are built
only in the browser after render, and the dropdown query is trimmed to the
two tag fields. Code is not the remaining bottleneck **if it is actually
published**. The two remaining suspects are outside the code:

1. **Unpublished code.** If the optimized page code hasn't been published,
   the live site still runs the old version that awaited a full collection
   fetch inside `onReady` (the exact behavior the blank shell shows).
2. **Dataset page size.** `#dataset2`'s "Number of items to display" in the
   editor decides how many community panels the server renders. If it is set
   above 9, SSR renders a panel (and queues an image) for every community -
   easily 4-5s of server render and most of the 2MB / 204 requests.

## Checklist to fix and verify

1. Editor -> Amenities page -> `#dataset2` settings -> **Number of items to
   display = 9**.
2. **Publish** the site.
3. Re-test in an incognito window (logged out).
4. Verify SSR now succeeds: `view-source:` on the live page should show a
   `<title>` tag and real markup inside `<div id="SITE_CONTAINER">`. If those
   are present, the server render completed.
5. Expected after fix: TTFB well under 2s, FCP in the 2-4s range, initial
   requests and page weight sharply down (only 9 community images load before
   "Load more").
6. If the page still blank-shells after 1-2: the remaining weight is page
   content, not code - look at heavy elements on the page itself (galleries,
   embeds, oversized images in the repeater panels) and the ClickCease script
   injected at body start.
