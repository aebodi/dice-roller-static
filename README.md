# Yahtzee Dice Roller

**Author:** Andres Bodington
**Project:** Yahtzee Dice Roller — Sprint 2

A small web application that rolls five 6-sided dice for a game of Yahtzee. Every roll is
decided by `Math.random()` and shown in read-only, right-justified fields, along with the
total, the highest die, and a count of the rolls made this session.

When the browser can load them, the roll is played out on a 3D felt tray built with Three.js
and a Rapier physics simulation. If those libraries cannot be reached, the application falls
back to flat CSS dice and keeps working — the numbers are identical either way.

## Credits

The application logic, layout, and styling are original work for this sprint. Two
third-party libraries are loaded from a CDN and are **not** original work:

- **Three.js** 0.160.0 — WebGL rendering of the 3D dice tray.
  MIT license. https://threejs.org
- **Rapier** (`@dimforge/rapier3d-compat`) 0.14.0 — rigid-body physics for the tumble.
  Apache-2.0 license. https://rapier.rs

Both are loaded at runtime from jsDelivr (https://www.jsdelivr.com); neither is bundled into
this repository.

AI use for this project is disclosed at the top of each source file.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure: instructions, dice fields, summary fields, and Roll button |
| `styles.css` | Presentation: felt-table theme, flat dice faces, layout, responsive rules |
| `script.js` | Random number generation and updating the read-only fields |
| `dice3d.js` | The 3D tray: Three.js rendering driven by a Rapier physics roll |

## Compiling

There is nothing to compile. The application is plain HTML, CSS, and JavaScript that the
browser runs directly — no build step, no package manager, no dependencies to install.

## Running

Open `index.html` in any modern web browser.

`dice3d.js` is an ES module, and browsers refuse to load modules from `file://` URLs. Opening
the file directly still works, but you will get the flat CSS dice rather than the 3D tray. To
see the 3D roll, serve the folder over HTTP instead:

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000 in your browser.

## Using the application

- The dice roll automatically when the page loads.
- Press **Enter** or click **Roll Dice** to throw all five dice again; the Roll button keeps
  focus so **Enter** always works.
- Each die has its own heading (Die 1 – Die 5), with Total of Dice, Highest Die, and Rolls
  This Session below them.
- A notable combination — “Yahtzee!”, “Full house!”, “Large straight!” — is named
  under the dice when it comes up.

## Deploy to Microsoft Azure (Static Web Apps)

The application is hosted as an Azure Static Web App.

1. Push this folder to a GitHub repository.
2. In the Azure portal choose **Create a resource → Static Web App**.
3. Set **Deployment source** to GitHub and pick the repository and branch.
4. Under **Build Details**, choose build preset **Custom**, set **App location** to `/`, and
   leave **Api location** and **Output location** empty — the site is plain HTML/CSS/JS with
   no build step.
5. Click **Review + create**. Azure adds a GitHub Actions workflow under `.github/workflows/`
   that publishes the site and gives you a URL like `https://<name>.azurestaticapps.net`.

Alternative with the Azure CLI:

```bash
az staticwebapp create \
  --name yahtzee-dice-roller \
  --resource-group <your-resource-group> \
  --source https://github.com/<user>/<repo> \
  --branch main \
  --app-location "/" \
  --login-with-github
```

## Coding standards

Source lines in this project are wrapped at 100 characters. Indentation is tabs; line endings
are LF. Source-code strings use straight single quotes; user-visible text uses curly quotes.

## License

MIT — see [LICENSE](LICENSE).
