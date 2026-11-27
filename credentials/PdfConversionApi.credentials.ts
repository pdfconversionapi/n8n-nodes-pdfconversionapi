import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class PdfConversionApi implements ICredentialType {
	name = 'pdfConversionApi';

	displayName = 'PDFConversionAPI API';

	icon: Icon = { light: 'file:pdfconversionapi.svg', dark: 'file:pdfconversionapi.dark.svg' };

	documentationUrl = 'https://pdfconversionapi.com/docs/authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Your key from https://app.pdfconversionapi.com (sign in with Google or GitHub; the Free plan needs no card)',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.pdfconversionapi.com',
			description: 'Leave as it is unless you were given another address',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// GET /v2/usage checks the key without using a conversion.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v2/usage',
			method: 'GET',
		},
	};
}
