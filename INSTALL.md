# Quire: build and install

Quire is one reader, packaged as a real app for four platforms.
Windows and Mac use Electron. iPhone and Android use Capacitor.
GitHub builds all four for you. You do not need a Mac or Android Studio.

## 1. Build the apps (once, about 15 minutes)

1. Create a new **private** repository on github.com.
2. Upload everything in this folder to it (keep the `.github` folder).
3. Open the repository, go to **Actions**, choose **Build apps**, press **Run workflow**.
4. When the four jobs finish, open the run and download the files under **Artifacts**:
   `Quire-Windows`, `Quire-macOS`, `Quire-Android`, `Quire-iPhone`.

If a job fails, open it, copy the red error text and send it to me.

## 2. Install

**Windows:** unzip `Quire-Windows`, run `Quire-Setup-1.0.0.exe`.
Windows will say "Windows protected your PC" because the installer is not
signed (a code-signing certificate costs money). Click **More info**, then **Run anyway**.
After installing, double-click any `.epub` or right-click, **Open with**, Quire.

**Mac:** open the `.dmg`, drag Quire to Applications. The first time, right-click the app,
press **Open**, then **Open** again (not signed by Apple). Use the arm64 file for M-series Macs.

**Android:** copy `Quire.apk` to the phone and tap it. Android will ask to allow installs
from your file manager or browser, allow it once. This build is signed with a debug key,
which is fine for your own phone.

**iPhone (free Apple ID, no Mac):**
1. On the PC, install **Sideloadly** from sideloadly.io, plus the web versions of iTunes and iCloud
   it asks for (not the Microsoft Store ones).
2. On the iPhone: Settings > Privacy & Security > **Developer Mode**, turn it on, restart.
3. Connect the iPhone by cable, tap Trust. In Sideloadly, drag in `Quire.ipa`,
   enter your Apple ID, press **Start**.
4. On the iPhone: Settings > General > **VPN & Device Management**, tap your Apple ID, **Trust**.

A free Apple ID lets the app run for **7 days**, then you sideload it again.
Before renewing, export your highlights (library menu) as a precaution.
Paid Apple Developer ($99 per year) removes the weekly step; ask me and I will switch the workflow to TestFlight.

## 3. Things to know

- The app is orange on white in light mode and orange on black in dark mode (Settings, Appearance: System, Light or Dark).
  Reading themes are Paper, Linen, Slate, Ember (warm dark) and Night. They are separate from the app mode.
- Your library lives on each device. There is no sync between laptop and phone.
- No DRM books (Kindle, Kobo purchases). EPUB only.
- Open from other apps on the phones: in **Files** (iPhone) or a file manager or **Downloads** (Android), tap an `.epub`
  and choose Quire; or use **Share** and pick Quire. The book is added to your library and opens.
  iPhone: if Quire is not listed straight away, choose **Share** or "Open in..." and scroll the app row.
  This is built but not tested on a real phone yet. If it does not work, **Add** inside the app still does.
- Not yet tested on a real iPhone, Android phone, Mac or installed Windows PC.
- The dictionary is English only and works fully offline (Princeton WordNet and the CMU Pronouncing Dictionary, about 20 MB inside the app).
  It has meanings, examples, similar words and pronunciation, but no word origins. Their license texts are in `www/dict/`; keep them if you share the app.
- **Aa > Turning pages**: **Curl**, **Slide** or **None**. Curl lifts the page by its corner and rolls it over, like Apple Books,
  on Windows, Mac, iPhone and Android (arrow keys, clicking or tapping the page edges, the mouse wheel, and swiping on phones).
  It slides instead in scroll mode, for right-to-left books, while the toolbar or a menu is open, when the page is zoomed,
  and on Android phones older than Android 8. Devices without WebGL get a simpler 3D page turn.
  If Windows has animations switched off (Settings, Accessibility, Visual effects, Animation effects), Quire starts with no page turn;
  open **Aa** and choose **Curl** or **Slide** to turn it on inside Quire.
  The phones take a picture of the page with a small piece of native code. It is built but not yet tested on a real phone;
  if a picture fails three times in a row, Quire slides the page for that session.
- The bar at the bottom of a book follows its table of contents: one segment per chapter, with wider gaps between parts.
  Hover over it with the mouse, or drag it with a finger, to see the page, the chapter and the part. Pages are counted from
  the layout on your screen, so the count changes with the font size; Quire remembers it for each book once it has measured a few chapters.
- **Focus mode** (Aa): only the text, with no running heads, page info, ribbon or mouse pointer. Click or tap the middle of the page for the menu.
- **Full window** (Windows and Mac): press **F11**, the frame button in the library, or **F** in a book. Press **Esc**, or move the mouse to the
  top edge and click the **X** that slides down, to get the title bar and window buttons back.
- **Reading goal** on the home screen: tap **Change** to pick books a month or a year. A book counts when you reach its end,
  or when you choose **Mark as finished** in its menu (the three dots).

## 4. Before you publish or share anything

- There are no API keys in this project. If you ever add one, put it in `.env` (already in `.gitignore`).
- `.gitignore` keeps secrets and build output out of Git.
- The installers only contain `electron/`, `www/` and `package.json` (see `build.files` in `package.json`).
  `INSTALL.md`, `.github/`, `resources/` and `node_modules/` are not packaged.
  Check this list if you change that setting.

## Developing

```
npm install
npm run desktop      # run the desktop app locally
npx cap sync         # copy www/ into the iOS and Android projects after editing
```
