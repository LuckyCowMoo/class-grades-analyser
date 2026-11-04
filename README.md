# Class Grades Analyser

A single-page website (hosted for free on GitHub Pages) that lets a teacher upload the zip of per-pupil report PDFs
exported from the school's assessment system, strips **all** names and identifying information **inside the browser**,
and asks a free reasoning model (chosen automatically from OpenRouter) which topics the class is struggling with,
which it is doing well in, and which pupils need extra help on which topics.

Pupil names are replaced with random codes (`P01`, `P02`, …) before anything is sent. When the AI's answer comes back,
the page swaps the codes back to names **locally**, so the teacher sees names but the AI never did.

```
PDF zip ──► read in browser ──► names / UPNs / DOB / contacts removed ──► table of codes + grades ──► AI
                                                                                                    │
teacher sees names ◄── codes swapped back on the teacher's computer ◄── AI answer (codes only) ◄────┘
```

## What is and is not sent to the AI

| Sent (anonymised)                                   | Never sent                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Random pupil codes (P01, P02 …)                     | Pupil names, UPNs, admission numbers, dates of birth                    |
| Assessment / topic names                            | Addresses, emails, phone numbers, parent/carer details                  |
| Grades, scores, targets, effort words               | Gender, SEN, pupil premium, FSM, ethnicity, attendance, behaviour (off by default) |
| Subject, year group and notes typed by the teacher  | Teacher, tutor, form, class and school names                            |
| Class averages computed locally                     | Written comments, the PDF files, the file names                         |

Three independent layers enforce this:

1. **Structured extraction only.** The AI receives a table built from the assessment rows the parser recognised; free text is never included.
2. **Scrubbing.** Every string that will be sent (assessment names, column headers, values, the teacher's notes and the template text itself) is scrubbed of every pupil's name tokens, UPN patterns, emails, phone numbers, postcodes and long numbers. Matches become `[removed]`.
3. **Outgoing guard.** The final message is scanned again and the *Analyse* button is disabled if any name, identifier, email, phone number or postcode is still present. The teacher can read the exact text that will be sent.

The file names of the exported PDFs (e.g. `Firstname-Surname-A123456789012.pdf`) contain the pupil's name **and their
UPN** (Unique Pupil Number: one check letter followed by 12 digits). Both are confidential; the site removes both and
only uses them locally to label the code key.

## Deploying on GitHub Pages

1. Create a repository on GitHub (for example `class-grades-analyser`) and push the contents of this folder to its `main` branch.
2. In the repository go to **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, select `main` and the `/ (root)` folder, then **Save**.
3. After a minute the site is available at `https://<your-username>.github.io/<repository-name>/`. Share that address with teachers.

No build step, server, database or environment variables are needed: everything is static HTML, CSS and JavaScript.
`pdf.js` and `JSZip` are vendored under `vendor/` so the site also works on school networks that block CDNs.

Important: the page must be opened over `http(s)://` (GitHub Pages or any web server). Double-clicking `index.html` from
a folder (`file://`) does not work because browsers block JavaScript modules there. To preview locally run
`python3 -m http.server 8000` in this folder and open <http://localhost:8000/>.

## Using the site (teacher instructions are also on the page)

1. **API key (once per computer).** Create a free account at [openrouter.ai](https://openrouter.ai), make a key under
   *Settings → Keys*, paste it into step 1 and click *Save key*. It is stored only in that browser's local storage.
2. **Upload.** Drop the zip downloaded from the school system (or the PDFs, or a folder) into step 2.
   *Try with sample data* loads a synthetic class with fictional pupils so you can see how it works.
3. **Check.** Review the pupil key (local only), tick/untick measure columns, fix any misread cell, add the subject
   and optional notes. The guard box must say *Safe to send*.
4. **Analyse.** Click *Analyse class*. The best free reasoning model is used; if it is busy the next one is tried.
   Toggle *Show names / Show codes*, then download the report (with names or codes only), the anonymised CSV,
   the pupil key, or print to PDF.

## How the parser adapts to different reports

Reports from SIMS, Arbor, Bromcom, Go4Schools and similar systems differ a lot, so the parser does not assume a layout:

* Text is read with positions and rebuilt into rows and cells (`js/pdf-extract.js`).
* Labelled fields (`Name:`, `UPN`, `Date of Birth`, `Form`, `Teacher`, `Attendance`, …) are recognised from a large
  list of synonyms and classified as identifying, sensitive, context or useful (`js/parse-report.js`).
* Assessment tables are detected in three shapes: a header row with measure columns (Grade / Score / Target / Effort …),
  "horizontal" tables where assessment names run across the page, and header-less `name | value` lists.
  Wrapped cells and multi-pupil PDFs (one pupil per page) are handled.
* Values are classified (percentages, `13/20`, GCSE 9–1 with `+`/`-`, A*–G, 4a/4b levels, WTS/EXS/GDS,
  Emerging/Developing/Secure, Pass/Merit/Distinction, RAG and effort words …) so class statistics can be computed and the
  model is told what each scale means.
* Any number and any names of assessments work; columns are unioned across the class.

If a report has an unusual layout, the per-file details show the text that was read, and the grid can be edited by hand.

## Model selection

`js/ai-client.js` fetches `GET https://openrouter.ai/api/v1/models`, keeps the models whose prompt and completion price
are both zero, drops non-text or special-purpose models (safety, audio, coding), requires reasoning support
(`supported_parameters` contains `reasoning` / `include_reasoning`), and ranks by model size, context length, family and
recency. The top candidates are tried in order; `openrouter/free` is the final fallback. The teacher can override the
choice. Requests use `provider.data_collection = "deny"` by default so only providers that do not store prompts are used.

Under *Advanced options* any other OpenAI-compatible service (e.g. a local model) can be used instead of OpenRouter.

## Project layout

```
index.html          page and teacher instructions
css/style.css
js/app.js           UI flow
js/pdf-extract.js   PDF → rows/cells (pdf.js)
js/parse-report.js  fields, PII labels, table detection, value classification
js/anonymise.js     codes, consolidation, payload, scrubbing, guard, CSV export
js/ai-client.js     OpenRouter model ranking, streaming, fallback
js/prompt.js        system / user prompts
js/markdown.js      safe Markdown renderer
vendor/             pdf.js and JSZip (vendored)
samples/            synthetic sample class (fictional pupils) for the demo button
```

## Privacy notes for the school

* No server-side component: nothing is uploaded to GitHub or anywhere else by the page. The only network calls are
  the model list and the chat request to the AI provider (or the custom endpoint the teacher configures).
* The API key is stored in the browser's local storage on the teacher's computer only (optional).
* The downloaded "with names" report is personal data and should be handled under the school's normal policies.
* The school's Data Protection Officer should be informed that the tool is in use; the *What is and is not sent*
  section on the page is written to support that conversation.
