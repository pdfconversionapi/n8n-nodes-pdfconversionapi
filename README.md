# n8n-nodes-pdfconversionapi

An [n8n](https://n8n.io) community node for [PDFConversionAPI](https://pdfconversionapi.com). It converts the file in an
item's binary field and puts the result back in a binary field: Word, Excel and PowerPoint to PDF, PDF to images, images
to PDF, and the other single-file conversions the API lists (550 on 27 Nov 2026).

## Installation

In a self-hosted n8n, open **Settings → Community Nodes → Install** and enter `n8n-nodes-pdfconversionapi`. See n8n's
[community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

Create a **PDFConversionAPI API** credential:

- **API Key**: your key from [app.pdfconversionapi.com](https://app.pdfconversionapi.com). Sign in with Google or
  GitHub; the Free plan includes 250 conversions a month and needs no card.
- **Base URL**: leave it as `https://api.pdfconversionapi.com`.

n8n checks the key with `GET /v2/usage`, which doesn't use a conversion.

## Operations

**File → Convert**

| Parameter | What it does |
|---|---|
| Conversion | From which format to which, chosen from the API's list, or `from/to` in an expression, such as `docx/pdf` |
| Input Binary Field | The field that holds the file (default `data`) |
| Options → API Parameters | Any of the conversion's parameters, as name and value, such as `UpdateFields` = `true` or `PdfaVersion` = `pdfA2b`. Each conversion's page at pdfconversionapi.com lists them |
| Options → Conversions at Once | How many items to convert at the same time (default 1). The Free plan runs 1 at a time; paid plans run 4 to 30 |
| Options → Put Output File in Field | The output binary field (default `data`) |
| Options → Wait When Busy | When the API answers 429 because the plan's conversions at once are all running, wait as long as its `Retry-After` header says and try again, up to 3 times (default on) |

Each converted file becomes one output item. A conversion that returns several files, such as PDF to JPG with one image
per page, returns one item per file. The item's JSON has `FileName`, `FileExt`, `FileSize`, `ConversionCost` and
`ConversionTime`.

**Account → Get Usage** returns this month's conversions, the plan's limits and what is running now.

## Errors

An error from the API stops the node with the API's status and message, for example
`400 PageRange is not supported yet for DOCX → PDF` or `401 a valid API key is required (Authorization: Bearer <key>)`.
Turn on the node's **Continue On Fail** setting to keep going and get the message in the item's JSON instead.

## Example

Read Files from Disk (or Google Drive, Gmail, a webhook) → PDFConversionAPI (Conversion: DOCX to PDF) → Write Files to
Disk (or any node that takes a binary file).

## Compatibility

Tested with n8n 2.49.7.

## Resources

- [Convert Word (DOCX) to PDF in n8n](https://pdfconversionapi.com/guides/docx-to-pdf-n8n): a tested workflow, also
  without this node
- [API documentation](https://pdfconversionapi.com/docs)
- [n8n community nodes](https://docs.n8n.io/integrations/#community-nodes)

## License

[MIT](LICENSE.md)
