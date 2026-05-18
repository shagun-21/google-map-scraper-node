import {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class EvomiProxyApi implements ICredentialType {
	name = 'evomiProxyApi';

	displayName = 'Evomi Proxy API';

	documentationUrl = 'https://evomi.com';

	properties: INodeProperties[] = [
		{
			displayName: 'Proxy Host',
			name: 'host',
			type: 'string',
			default: 'core-residential.evomi.com',
			required: true,
		},
		{
			displayName: 'Proxy Port',
			name: 'port',
			type: 'number',
			default: 1000,
			required: true,
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Country Code',
			name: 'country',
			type: 'string',
			default: 'IN',
			description: 'ISO country code for residential IP routing (e.g. IN, US, GB)',
			required: true,
		},
	];
}
