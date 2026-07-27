#!/usr/bin/env node
/*
 * One-off: rewrites every village assignment block in the dashboard source to
 * the official neighborhood names and URL slugs (provided June 2026), keyed by
 * the block's village1 UUID. Run before scripts/generate-villages-seed.js.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = path.resolve(__dirname, '..', 'Property Management - Dashboard Page Code.txt');

// villageId -> [official name, official slug]
const OFFICIAL = {
  'c5d64be9-d2ee-4a94-be2f-3a069139bae8': ['Aquarius Club', 'aquarius-club'],
  '571f7019-8fd7-4e0b-9316-09416e4eb42c': ['Arbomar', 'arbomar'],
  '4553118b-50a7-40f6-b9f6-cb312f6c076c': ['Aria', 'aria'],
  '87e95209-e6b7-4d71-a61f-11b92b3f272b': ['Banyan Bay Club', 'banyan-bay-club'],
  '58891516-885a-484b-87c9-4fe8b97fa065': ['Bay Harbour', 'bay-harbour'],
  'bc8b3074-9ef5-4cf7-88bd-1886c7df5c8e': ['Bay Isles - Harbor Section', 'bay-isles-harbor-section'],
  '31f92f08-0123-4d45-adf2-e84aed003790': ['Bayou Hammock', 'bayou-hammock'],
  'fa3c3321-c938-4f6c-b778-278a5c2444fc': ['Bayport Beach & Tennis', 'bayport-beach-and-tennis'],
  'a52bc94a-6483-4d28-8358-8799d52ddc87': ['Bayview Estates', 'bayview-estates'],
  '6645876a-a29b-4708-a6ae-4eeab18809dd': ['Beach Castle', 'beach-castle'],
  '3ccb68d1-2269-4a6d-b4ac-5175a8f82fc1': ['Beach Harbor Club', 'beach-harbor-club'],
  '8554d0f6-66fa-4436-a922-4304d4275892': ['Beachcomber', 'beachcomber'],
  '26d9bd72-ba70-4c3d-8820-950e40d886b4': ['Beachplace', 'beachplace'],
  '76bc1da1-8297-4b35-b0cd-e9cca76a0125': ['Buttonwood Cove', 'buttonwood-cove'],
  '3e003132-d274-4287-bd08-5af1b0f53832': ['Buttonwood Harbor', 'buttonwood-harbor'],
  '8bf0b60c-6254-4748-9964-c77fb3a8e97a': ['Cabana Beach Club', 'cabana-beach-club'],
  '47fe9346-8cb0-41b3-8cca-762936d955c7': ['Casa Del Mar', 'casa-del-mar'],
  'e80bb050-3770-4ecd-8509-f347afbccd5a': ['Castillian', 'castillian'],
  'ef668008-26c6-40df-9ad3-53c61ddba873': ['Cedars East', 'cedars-east'],
  'e63620da-3b70-4f41-97c7-e0ecf5deea98': ['Cedars West', 'cedars-west'],
  'd48c2586-c72a-40c4-88bb-d6e27a8793e5': ['Club Longboat', 'club-longboat'],
  '55bd3c37-f295-407f-ade6-7b29bf08de40': ['Conrad Beach', 'conrad-beach'],
  'fa659528-eda8-49bc-b683-13c13a17d92c': ["Corey's Landing (Bay Isles)", 'coreys-landing-bay-isles'],
  '32f9f98c-3469-42a7-b581-961b3a2514fb': ['Country Club Shores', 'country-club-shores'],
  '42466230-1219-496d-9040-3b10fc076e69': ['Dream Island', 'dream-island'],
  '89d54c7b-fb11-42a8-b678-50077213d870': ['Emerald Harbor', 'emerald-harbor'],
  'aa05a451-396d-4ece-a5b6-6ff66fa8f517': ['Emerald Pointe (Bay Isles)', 'emerald-pointe-bay-isles'],
  'df6a5cbf-3fd8-41d9-a263-a745d610f82e': ['En Provence', 'en-provence'],
  'fe044dda-6a71-4520-b580-f08d0d5bb292': ['Fairway Bay (Bay Isles)', 'fairway-bay-bay-isles'],
  '19f93ef7-967f-45da-84cd-9bfa22dab778': ['Grand Bay (Bay Isles)', 'grand-bay-bay-isles'],
  '8c839e9e-141f-4295-9897-248d3337e18c': ['Grand Mariner', 'grand-mariner'],
  '216f06af-96ee-47aa-8991-2a8013f98439': ['Harbour Circle (Bay Isles)', 'harbour-circle-bay-isles'],
  '37691463-0f0a-4cba-981f-794d79cffe33': ['Harbour Court (Bay Isles)', 'harbour-court-bay-isles'],
  'c94a290d-de49-43cc-a507-fc6397f29d5b': ['Harbour Links (Bay Isles)', 'harbour-links-bay-isles'],
  '57962457-4ff2-4a9d-a0a7-fbc03635239f': ['Harbour Oaks (Bay Isles)', 'harbour-oaks-bay-isles'],
  'b18194e8-0315-4706-bce3-e337d8807875': ['Harbour Villa Club', 'harbour-villa-club'],
  'cc9f4a2a-9e84-425f-a48a-99d113ac0bd3': ['Hideaway Bay', 'hideaway-bay'],
  '6fbd88ea-c572-4b36-9345-2669052e7275': ['Infinity', 'infinity'],
  '2df718de-ccc3-4f0b-956d-ece986de9b6b': ['Inn on the Beach', 'inn-on-the-beach'],
  '03975263-8664-41d6-a36f-83d7ebec9970': ['Islander Club', 'islander-club'],
  '6355a51e-38e0-4aba-9c7c-abfc64f0b732': ['Islands West', 'islands-west'],
  '675707ed-eaab-4c93-921d-9a4386b5bddf': ['Jewfish Key', 'jewfish-key'],
  'd7953eac-c9fa-4931-9f3b-1f17ea5c852f': ["L'Ambiance", 'ambiance'],
  'ba4f760e-91cf-49e0-9559-56ff1697c9c1': ['La Firenza', 'la-firenza'],
  '79d9402b-58da-4c29-acf1-ea5fd6062ca6': ['La Playa', 'la-playa'],
  '9ca880b3-9aac-47e1-955e-24e49b9f0811': ['Laguna Yacht Village', 'laguna-yacht-village'],
  '20c876b5-6c6e-403c-8d58-b100d1259d6e': ['Lands End', 'lands-end'],
  '2d970c22-8d22-440a-88d0-3cf28eb16873': ['Lighthouse Point', 'lighthouse-point'],
  'ac3de942-a4c0-46f7-aebc-d2ed7314a6c8': ['Longbeach Village', 'longbeach-village'],
  '312ff01d-8697-4ef7-b6d2-b4a0d1eeffdd': ['Longboat Arms', 'longboat-arms'],
  'ef003afc-16af-45ad-aff1-859ebeeeadbc': ['Longboat Beach House', 'longboat-beach-house'],
  'a6ddaacc-14e5-4041-a123-ef4ec9bd5640': ['Longboat Harbour', 'longboat-harbour'],
  'a1d8f310-966b-4d68-ae92-521186d328c5': ['Longboat Harbour Towers', 'longboat-harbour-towers'],
  '6aa3f7f7-1ef2-4037-901f-c691d566a63c': ['Longboat Key Estates', 'longboat-key-estates'],
  'a8e5bc7b-2ee5-4df1-99da-b6b58fbabdd3': ['Longboat Key Towers', 'longboat-key-towers'],
  '890c95c6-ab4b-46a4-b212-854f3be6826f': ['Longboat Landing', 'longboat-landing'],
  '93b2bc88-383d-45b0-aab4-b54100364e02': ['Longboat Shores', 'longboat-shores'],
  '4e87870d-6ca1-43c7-b8bd-1d341b82dfd2': ['Longboat Terrace', 'longboat-terrace'],
  '1c21b5c9-ecd5-471d-a656-90a32d034f78': ['Marina Bay (Bay Isles)', 'marina-bay-bay-isles'],
  '6dbf2382-6ba6-4d57-ace5-7ad0087248f3': ['Neptune', 'neptune'],
  'c3176bfd-52b9-4ca3-899b-0cad27c551f8': ['Northgate', 'northgate'],
  'fc4ab52b-3dde-4b36-9b85-595336f4273b': ['Pelican Harbour & Beach Club', 'pelican-harbour-%26-beach-club'],
  '37c56e34-4722-467a-99e4-d5884eb0a8e9': ['Pierre', 'pierre'],
  '56c00258-e6c1-4aa2-aaa4-9ca4c15dad5f': ['Players Club', 'players-club'],
  '9fca54d1-d3f6-4615-b7a1-8fc110b034d6': ['Portobello', 'portobello'],
  'ea35bf0a-9f97-4b59-a398-aab3e55bca23': ['Positano', 'positano'],
  '10b4f62e-3e2c-46b8-b568-858b71f81473': ['Privateer', 'privateer'],
  'abd8f137-2e49-45f7-bef9-d42760495421': ['Promenade', 'pomenade'],
  'd25c7035-7cd6-4a74-a476-11eb9307a5d0': ['Queens Harbour (Bay Isles)', 'queens-harbour-bay-isles'],
  'adc9f424-258d-45cf-96d1-be8f462a39cf': ['Regent Court', 'regent-court'],
  '3c840976-2580-4628-83b7-cfb0f37725ee': ['Regent Place', 'regent-place'],
  'c98eb7ae-d316-42ad-ba49-403a4a2a77f1': ['Sabal Cove (Bay Isles)', 'sabal-cove-bay-isles'],
  '362f3e3b-46cd-4ef2-9c23-c03d912c90a0': ['Sage Longboat Key', 'sage-longboat-key'],
  '847f98e8-a3c3-4a5e-8a8b-3be717c2bbf8': ['Sand Cay Beach Resort', 'sand-cay-beach-resort'],
  '6e850cab-adb3-43af-a7cc-fca98302c4f9': ['Sands Point', 'sands-point'],
  'a6c98916-cada-49b0-b3d5-1fa7a2a1248f': ['Sea Gate Club', 'sea-gate-club'],
  '5c35b7f8-aa9a-4133-abe5-89f377e774eb': ['Sea Grape Inn', 'sea-grape-inn'],
  '82e57346-7551-47a8-9bea-c13e4ffe64ff': ['Sea Oats', 'sea-oats'],
  'a0e17d88-13b4-4a7b-ac52-e13d2c811752': ['Sea Pines', 'sea-pines'],
  '9766086d-8c26-4c54-a9ce-90224d951e58': ['Seahorse Beach Resort', 'seahorse-beach-resort'],
  '3546f1bc-80df-4566-b043-6f2aefc16a19': ['Seaplace', 'seaplace'],
  '77f01d50-ed3f-411c-aca1-06739ef659c6': ['Seascape', 'seascape'],
  '23a5c9d3-7044-4a80-ac8c-ff22f591535f': ['Silver Sands', 'silver-sands'],
  '454bad1b-06de-4f9f-8a0b-7f2eb428ca79': ['Sleepy Lagoon', 'sleepy-lagoon'],
  'dea2055b-e01b-4de5-8dd3-2e417a9214e1': ['Spanish Main Yacht Club (55+)', 'spanish-main-yacht-club'],
  '6a428652-a704-4bfc-92e4-5dafb18abc68': ['Sunset Beach', 'sunset-beach'],
  'a51658d2-e2ca-4836-a411-4a36a3f54d23': ['Sutton Place', 'sutton-place'],
  '060f1667-6105-4fa3-a650-dccd61e44d78': ['Tangerine Bay Club', 'tangerine-bay-club'],
  '98eb305d-0b83-496c-8b87-d5982cef505c': ['The Bayou (Bay Isles)', 'the-bayou-bay-isles'],
  '54b293fa-3cee-472b-a6c1-7a27f38172d8': ['The Beach on Longboat Key', 'the-beach-on-longboat-key'],
  '77e7e1ce-f445-46a3-8dcf-0740aff9034b': ['The Beaches', 'the-beaches'],
  'f72ab8ac-0088-4d8c-a134-6d4697d9b73f': ['The Grande at Longboat Key', 'the-grande-at-longboat-key'],
  '34eb509c-19b7-4e0a-968c-fa257529bf62': ['The Residences at The St. Regis', 'the-residences-at-the-st-regis'],
  '6ca2f7b7-3f18-4ace-8566-e86ccee2b4d3': ['The Sanctuary', 'the-sanctuary'],
  'c55aaf0a-bc94-4f1e-b744-7ddcd32cd5d4': ['The Shore', 'the-shore'],
  '8e7822ae-c315-4434-bd09-bb02a5a5085c': ['Tiffany Plaza', 'tiffany-plaza'],
  'caf4d2d3-f007-4ced-be9b-d535e2126b87': ['Turtle Crawl Inn', 'turtle-crawl-inn'],
  'c92a6bc1-a2f7-4df5-ae83-5e46e18cda2f': ['Veinte', 'veinte'],
  '5c2a206e-68a1-4b4b-8ddf-f3bbf4494b54': ['Villa di Lancia', 'villa-di-lancia'],
  '0b9db51f-91da-42a6-9435-03797d9305c4': ['Vizcaya', 'vizcaya'],
  'f87c271c-63a1-4fb8-89fd-2dc3f452a6b9': ['Water Club', 'the-water-club'],
  '37f82a06-77fe-4ba5-81ee-b826822cb794': ['Westchester', 'westchester'],
  'c64ba845-05e9-4958-bde4-80b6c4e2e721': ['Weston Pointe (Bay Isles)', 'weston-pointe-bay-isles'],
  'c0482a6c-0433-4388-b91e-0e89ce50d370': ['Whitney Beach', 'whitney-beach'],
  'f2538b9a-4494-4154-b8fe-60c5db7a3cc5': ['Winding Oaks (Bay Isles)', 'winding-oaks-bay-isles'],
  '9d1cf7a0-0694-42bd-9fd6-cce8c77ddd5c': ['Windward Bay', 'windward-bay']
};

const src = fs.readFileSync(SOURCE, 'utf8');

const blockRe = /valData\['Village'\] = "([^"]*)";(\s*)valData\['villageSortHelp'\] = "([^"]*)";(\s*)valData\['VillageURL'\] = `\$\{baseURL\}\/neighborhood\/([^`]*)`;(\s*)valData\['village1'\] = "([0-9a-f-]{36})";/g;

let rewritten = 0;
const unknown = [];
const out = src.replace(blockRe, (match, name, ws1, sortHelp, ws2, slug, ws3, id) => {
  const official = OFFICIAL[id];
  if (!official) {
    unknown.push(`${id} (${name})`);
    return match;
  }
  rewritten += 1;
  return `valData['Village'] = "${official[0]}";${ws1}` +
    `valData['villageSortHelp'] = "${official[0]}";${ws2}` +
    `valData['VillageURL'] = \`\${baseURL}/neighborhood/${official[1]}\`;${ws3}` +
    `valData['village1'] = "${id}";`;
});

fs.writeFileSync(SOURCE, out);
console.log(`rewrote ${rewritten} village blocks`);
if (unknown.length) {
  console.warn('unknown village1 ids (left untouched):');
  for (const u of unknown) console.warn('  ' + u);
}
