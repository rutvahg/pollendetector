# Pollen Check

A mobile web app that photographs a pollen sample, counts the grains and shows the pollen level as **Low**, **Medium** or **High**. History stays on your phone; you can optionally sync photos to a Google Drive folder and results to a Google Sheet through a small Google Apps Script backend.

Plain HTML, CSS and JavaScript, with no build step. It runs on GitHub Pages as is.

## What's included

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/` | The web app |
| `js/analysis.js` | Grain detector (image processing; see "How the analysis works") |
| `js/sync.js` | Sync to your Apps Script backend |
| `js/forecast.js` | Optional area forecast from the Google Pollen API |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and add-to-home-screen |
| `apps-script/Code.gs`, `apps-script/appsscript.json` | The Google Apps Script backend |

## 1. Put the app online (GitHub Pages)

1. Create a new GitHub repository, e.g. `pollen-check`. It can be public, or private if you have GitHub Pro.
2. Upload everything in this folder to the repository root (`index.html` at the top level). You can leave out `apps-script/`, because it isn't used by the website.
3. In the repository go to **Settings › Pages**, set **Source** to *Deploy from a branch*, and choose `main` / `(root)`. Save.
4. After a minute the app is live at `https://<your-username>.github.io/pollen-check/`.
5. Open that address on your phone. To install it, tap **Share › Add to Home Screen** in Safari, or **⋮ › Add to Home screen** in Chrome.

The camera only works over **https://**. GitHub Pages provides that automatically. For local testing, `python3 -m http.server` on `localhost` also works.

## 2. Set up sync to Google Drive & Sheets (optional)

1. Go to <https://script.google.com> and click **New project**. Name it *Pollen Check Sync*.
2. Replace the contents of `Code.gs` with `apps-script/Code.gs` from this folder and save.
3. (Optional) Under **Project Settings**, tick *Show "appsscript.json"* and paste in `apps-script/appsscript.json`.
4. Choose the `setup` function in the toolbar and click **Run**. Approve the Drive and Sheets permissions. You'll see a warning that the app isn't verified, because it's your own script: click *Advanced › Go to Pollen Check Sync*.
5. Open **Execution log**. It shows your new Drive folder, your Sheet and your **secret key**.
6. Click **Deploy › New deployment**. Choose the gear icon, select **Web app**, then set:
   - **Execute as:** Me
   - **Who has access:** Anyone
   - Click **Deploy** and copy the **Web app URL** (ends in `/exec`).
7. In the app, open **Settings**, paste the URL and the secret key, and tap **Test connection**. You should see **Works**.

**Updating the script later:** go to **Deploy › Manage deployments**, click **Edit** (pencil), set **Version: New version** and click **Deploy**. Otherwise the URL keeps running the old code.

**Why "Anyone"?** The app runs on GitHub Pages, not on a Google page, so it can't send your Google login. The secret key protects it: requests without the right key are rejected. Keep the key out of your GitHub repo. It's stored on your phone only.

### What gets saved

- **Drive folder "Pollen samples":** one JPEG per sample, named `pollen_YYYY-MM-DD_HHmmss_<id>.jpg`. Photos are shrunk to 2048 px for upload, and the full-size original stays on the phone.
- **Sheet "Pollen log":** one row per sample, with Capture ID, Captured at, Synced at, Level, Grains per cm², Grain count, Confidence, Dominant type and type percentages (for Phase 2), Latitude/Longitude (only if *Include location* is on), Photo link, Source and App version.
- Syncing the same sample twice never creates a duplicate row or photo.
- Deleting a sample in the app does not delete it from Drive or the Sheet.

## 3. Area forecast (optional)

1. In Google Cloud Console, create or select a project, enable the **Pollen API**, and create an API key.
2. Restrict the key: **Application restrictions › Websites**, then add `https://<your-username>.github.io/*`. Under **API restrictions**, select *Pollen API* only.
3. In the app, open **Settings › Area forecast**, turn it on, and paste the key.

The key is visible to anyone who looks at the page's network requests, which is why the website restriction matters. Google may require a billing account for the Pollen API. Check its current pricing and free usage before enabling it.

## How the analysis works

`js/analysis.js` is a classic image-processing detector, **not a trained model**:

1. Crop to the framing box (camera) or use the whole image (upload), and scale to at most 1024 px.
2. Check quality: brightness, and sharpness measured from the crispest edges (the 99.9th percentile of the Laplacian).
3. Subtract the local background (a large box blur), so uneven microscope lighting doesn't matter.
4. Mark pixels that differ from the background by more than 3.5× the noise level. By default it works out automatically whether grains are darker or lighter than the background.
5. Group marked pixels into connected spots, and keep the ones that are grain-sized and roughly round.
6. Convert the count to grains per cm² using **Area inside the box**, then to a level using the **Low** and **Medium** thresholds.

**The default numbers are placeholders.** To make the levels meaningful:

- Measure the area your framing box covers at your lens's magnification (photograph a ruler or a calibration slide) and enter it as *Area inside the box*.
- Adjust *Smallest/Largest grain* so the yellow circles on the result screen match real grains.
- Over a few weeks, compare your counts with the area forecast or a local monitoring station and set the Low and Medium thresholds to match.

**Pollen type (Phase 2)** isn't included. Telling tree, grass and weed pollen apart reliably needs a trained image model and roughly 200–400× magnification.

## Browser notes

- **iPhone (Safari 16.4+):** the live camera works. The flashlight button and full-resolution stills aren't available in Safari. For the sharpest image, tap **Upload photo** and choose **Take Photo** to use the phone's camera app.
- **Android (Chrome):** live camera, flashlight and full-resolution capture all work.
- Your history lives in the browser's storage (IndexedDB). Clearing site data deletes it, so use sync or **Settings › Export history** to keep a copy.

For information only. This app does not give medical advice.
