import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

// Programmatic style, because a conversion uploads the item's binary file as multipart form data,
// turns the base64 files in the JSON reply back into binary data, and paces requests to the plan's
// conversions-at-once limit. Declarative routing can't do any of the three.

const DEFAULT_BASE_URL = 'https://api.pdfconversionapi.com';
const TIMEOUT_MS = 240_000; // a conversion may run for 120 seconds, plus the upload
const MAX_BUSY_RETRIES = 3;

interface ApiFile {
	FileName?: string;
	FileExt?: string;
	FileSize?: number;
	FileData?: string;
	Url?: string;
}

interface ConvertOptions {
	outputBinaryPropertyName?: string;
	conversionsAtOnce?: number;
	waitWhenBusy?: boolean;
	parameters?: { parameter?: Array<{ name: string; value: string }> };
}

async function baseUrlOf(ctx: IExecuteFunctions | ILoadOptionsFunctions): Promise<string> {
	try {
		const credentials = await ctx.getCredentials('pdfConversionApi');
		return String(credentials.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
	} catch {
		return DEFAULT_BASE_URL;
	}
}

/** A multipart/form-data body with the API parameters first and the file as `File`. */
function multipartBody(
	fileName: string,
	data: Buffer,
	fields: Array<{ name: string; value: string }>,
): { body: Buffer; contentType: string } {
	const boundary = `----n8nPdfConversionApi${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
	const safe = (text: string) => text.replace(/["\r\n\\]/g, '_');
	const parts: Buffer[] = [];
	for (const field of fields) {
		parts.push(
			Buffer.from(
				`--${boundary}\r\nContent-Disposition: form-data; name="${safe(field.name)}"\r\n\r\n${field.value}\r\n`,
				'utf8',
			),
		);
	}
	parts.push(
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="File"; filename="${safe(fileName)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
			'utf8',
		),
	);
	parts.push(data);
	parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
	return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function parseBody(body: unknown): IDataObject {
	if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body as IDataObject;
	const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
	try {
		return JSON.parse(text) as IDataObject;
	} catch {
		return { Message: text.slice(0, 500) };
	}
}

/** A 429 that waiting can fix: the plan's conversions at once are all running, or the rate limit. */
function isBusy(status: number, message: string): boolean {
	return status === 429 && /at a time|slow down/i.test(message);
}

// Not offered as an AI agent tool: it reads and writes binary files, which tool calls don't carry.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class PdfConversionApi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'PDFConversionAPI',
		name: 'pdfConversionApi',
		icon: { light: 'file:pdfconversionapi.svg', dark: 'file:pdfconversionapi.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle:
			'={{$parameter["resource"] === "account" ? "Get usage" : ($parameter["conversion"] || "").replace("/", " to ")}}',
		description: 'Convert files with PDFConversionAPI: Word, Excel and PowerPoint to PDF, PDF to images, and more',
		defaults: {
			name: 'PDFConversionAPI',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'pdfConversionApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'File', value: 'file' },
					{ name: 'Account', value: 'account' },
				],
				default: 'file',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['file'] } },
				options: [
					{
						name: 'Convert',
						value: 'convert',
						description: 'Convert the file in a binary field to another format',
						action: 'Convert a file',
					},
				],
				default: 'convert',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get Usage',
						value: 'getUsage',
						description: "Get this month's conversions, the plan's limits and what is running now",
						action: 'Get usage',
					},
				],
				default: 'getUsage',
			},
			{
				displayName: 'Conversion Name or ID',
				name: 'conversion',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getConversions' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['file'], operation: ['convert'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				hint: 'In an expression, write the conversion as from/to, for example docx/pdf',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				displayOptions: { show: { resource: ['file'], operation: ['convert'] } },
				description: 'The name of the input binary field that holds the file to convert',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { resource: ['file'], operation: ['convert'] } },
				options: [
					{
						displayName: 'API Parameters',
						name: 'parameters',
						type: 'fixedCollection',
						typeOptions: { multipleValues: true },
						default: {},
						placeholder: 'Add parameter',
						description:
							'Conversion parameters, as listed on the page for each conversion at pdfconversionapi.com, for example UpdateFields = true or PdfaVersion = pdfA2b',
						options: [
							{
								displayName: 'Parameter',
								name: 'parameter',
								values: [
									{ displayName: 'Name', name: 'name', type: 'string', default: '' },
									{ displayName: 'Value', name: 'value', type: 'string', default: '' },
								],
							},
						],
					},
					{
						displayName: 'Conversions at Once',
						name: 'conversionsAtOnce',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 30 },
						default: 1,
						description:
							'How many items to convert at the same time. The Free plan runs 1 at a time; paid plans run 4 to 30.',
					},
					{
						displayName: 'Put Output File in Field',
						name: 'outputBinaryPropertyName',
						type: 'string',
						default: 'data',
						description: 'The name of the output binary field for the converted file',
					},
					{
						displayName: 'Wait When Busy',
						name: 'waitWhenBusy',
						type: 'boolean',
						default: true,
						description:
							"Whether to wait and try again (up to 3 times) when the API answers 429 because the plan's conversions at once are all running",
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getConversions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const baseUrl = await baseUrlOf(this);
				const list = (await this.helpers.httpRequest({
					method: 'GET',
					url: `${baseUrl}/v2/info`,
					json: true,
				})) as Array<{ From: string; To: string; Title: string; Category: string; Inputs: string }>;
				return list
					.filter((c) => c.Inputs === 'one')
					.map((c) => ({ name: c.Title, value: `${c.From}/${c.To}`, description: c.Category }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const baseUrl = await baseUrlOf(this);

		if (resource === 'account') {
			const out: INodeExecutionData[] = [];
			for (let i = 0; i < items.length; i++) {
				try {
					const usage = (await this.helpers.httpRequestWithAuthentication.call(this, 'pdfConversionApi', {
						method: 'GET',
						url: `${baseUrl}/v2/usage`,
						json: true,
					})) as IDataObject;
					out.push({ json: usage, pairedItem: { item: i } });
				} catch (error) {
					if (this.continueOnFail()) {
						out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
						continue;
					}
					throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
				}
			}
			return [out];
		}

		const convertItem = async (i: number): Promise<INodeExecutionData[]> => {
			const conversion = String(this.getNodeParameter('conversion', i)).trim().toLowerCase();
			const match = /^([a-z0-9]+)\/([a-z0-9]+)$/.exec(conversion);
			if (!match) {
				throw new NodeOperationError(
					this.getNode(),
					`Conversion "${conversion}" isn't in the form from/to, for example docx/pdf`,
					{ itemIndex: i },
				);
			}
			const [, from, to] = match;
			const inputField = this.getNodeParameter('binaryPropertyName', i) as string;
			const options = this.getNodeParameter('options', i, {}) as ConvertOptions;
			const outputField = options.outputBinaryPropertyName || 'data';
			const waitWhenBusy = options.waitWhenBusy !== false;

			const binary = this.helpers.assertBinaryData(i, inputField);
			const data = await this.helpers.getBinaryDataBuffer(i, inputField);
			const fields = (options.parameters?.parameter ?? []).filter((p) => p.name.trim() !== '');
			const { body, contentType } = multipartBody(binary.fileName || `file.${from}`, data, fields);

			const request: IHttpRequestOptions = {
				method: 'POST',
				url: `${baseUrl}/v2/convert/${from}/to/${to}`,
				headers: { 'Content-Type': contentType },
				body,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				timeout: TIMEOUT_MS,
			};

			for (let attempt = 0; ; attempt++) {
				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'pdfConversionApi',
					request,
				)) as IN8nHttpFullResponse;
				const reply = parseBody(response.body);
				const status = response.statusCode;
				const message = String(reply.Message ?? '');

				if (isBusy(status, message) && waitWhenBusy && attempt < MAX_BUSY_RETRIES) {
					const retryAfter = Number(response.headers?.['retry-after'] ?? 5);
					await sleep(Math.min(Math.max(Number.isFinite(retryAfter) ? retryAfter : 5, 1), 30) * 1000);
					continue;
				}
				if (status !== 200) {
					throw new NodeApiError(this.getNode(), reply as JsonObject, {
						itemIndex: i,
						httpCode: String(status),
						message: `${status} ${message || 'The API returned an error'}`,
					});
				}

				const files = (reply.Files ?? []) as ApiFile[];
				const summary = {
					ConversionCost: reply.ConversionCost,
					ConversionTime: reply.ConversionTime,
				};
				const out: INodeExecutionData[] = [];
				for (const file of files) {
					const { FileData, ...info } = file;
					const item: INodeExecutionData = { json: { ...info, ...summary }, pairedItem: { item: i } };
					if (FileData) {
						item.binary = {
							[outputField]: await this.helpers.prepareBinaryData(
								Buffer.from(FileData, 'base64'),
								file.FileName,
							),
						};
					}
					out.push(item);
				}
				return out;
			}
		};

		const firstOptions = this.getNodeParameter('options', 0, {}) as ConvertOptions;
		const atOnce = Math.min(Math.max(Math.floor(firstOptions.conversionsAtOnce ?? 1), 1), 30);
		const results: INodeExecutionData[][] = new Array(items.length);
		for (let start = 0; start < items.length; start += atOnce) {
			const batch = [];
			for (let i = start; i < Math.min(start + atOnce, items.length); i++) {
				batch.push(
					convertItem(i).then(
						(out) => {
							results[i] = out;
						},
						(error: Error) => {
							if (this.continueOnFail()) {
								results[i] = [{ json: { error: error.message }, pairedItem: { item: i } }];
								return;
							}
							throw error;
						},
					),
				);
			}
			await Promise.all(batch);
		}
		return [results.flat()];
	}
}
