import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

import axios, { AxiosResponse } from 'axios';
import * as http from 'http';
import * as https from 'https';

// ============================================================
// CONSTANTS
// ============================================================
const PAGE_SIZE = 20;
const MAX_OFFSET = 400;
const MIN_RESPONSE_SIZE = 10000;
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESULTS = 240;

const COOKIES =
	'CONSENT=YES+cb.20210720-07-p0.en+FX+410; SOCS=CAESHAgBEhJnd3NfMjAyMzA1MTYtMF9SQzIaAmVuIAEaBgiAjYWkBg';

const USER_AGENTS = [
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];

// ============================================================
// TYPES
// ============================================================
interface ProxyConfig {
	host: string;
	port: number;
	username: string;
	password: string;
	country: string;
}

interface OpeningHour {
	day: string;
	hours: string;
}

type AdditionalInfoSection = Record<string, boolean>[];
type AdditionalInfo = Record<string, AdditionalInfoSection>;

interface Place {
	title: string | null;
	subTitle: string | null;
	description: string | null;
	categoryName: string | null;
	categories: string[] | null;
	placeId: string | null;
	fid: string | null;
	cid: string | null;
	kgmid: string | null;

	phone: string | null;
	phoneUnformatted: string | null;
	address: string | null;
	neighborhood: string | null;
	street: string | null;
	city: string | null;
	postalCode: string | null;
	state: string | null;
	countryCode: string | null;
	plusCode: string | null;
	locatedIn: string | null;
	floor: string | null;

	location: { lat: number | null; lng: number | null };

	totalScore: number | null;
	reviewsCount: number | null;
	reviewsTags: string[];

	imageUrl: string | null;
	imagesCount: number | null;
	imageCategories: string[];

	price: string | null;

	permanentlyClosed: boolean;
	temporarilyClosed: boolean;
	claimThisBusiness: boolean;

	url: string | null;
	website: string | null;
	website_domain: string | null;
	menu: string | null;
	servicesLink: string | null;
	reserveTableUrl: string | null;
	googleFoodUrl: string | null;
	searchPageUrl: string | null;
	searchString: string | null;

	openingHours: OpeningHour[];

	additionalInfo: AdditionalInfo;
	popularTimesLiveText: string | null;
	popularTimesLivePercent: number | null;
	popularTimesHistogram: Record<string, unknown>;
	peopleAlsoSearch: string[];
	placesTags: string[];

	hotelStars: number | null;
	hotelDescription: string | null;
	checkInDate: string | null;
	checkOutDate: string | null;
	hotelAds: unknown[];
	gasPrices: unknown[];

	rank: number | null;
	isAdvertisement: boolean;
	language: string | null;
	scrapedAt: string;

	raw_record?: any;
}

interface PaginationResult {
	places: Place[];
	lastOffset: number;
	stopReason: string;
	pagesFetched: number;
	debugLog: string[];
}

// ============================================================
// HELPERS
// ============================================================
function generateSessionId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).substring(2, 10);
	return `${ts}${rand}`.substring(0, 14);
}

function pickUserAgent(): string {
	return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function dig(obj: any, ...path: (string | number)[]): any {
	let c: any = obj;
	for (const p of path) {
		if (c == null) return null;
		c = c[p];
	}
	return c == null ? null : c;
}

function stripXSSI(text: string): string {
	return text.replace(/^\/\*""\*\//, '').replace(/^\)\]\}'[\r\n]*/, '').trim();
}

function extractPhone(r: any): string | null {
	const s = JSON.stringify(r);
	const intl = s.match(/"\+91[\s\d]{9,14}"/);
	if (intl) return intl[0].replace(/"/g, '');
	const local = s.match(/"0\d{2,4}[\s\d]{6,10}"/);
	if (local) return local[0].replace(/"/g, '');
	return null;
}

function extractPlaceId(r: any): string | null {
	const s = JSON.stringify(r);
	const m = s.match(/"(ChIJ[A-Za-z0-9_-]{20,})"/);
	return m ? m[1] : null;
}

function extractCid(r: any): string | null {
	const direct = dig(r, 78);
	if (direct && typeof direct === 'string' && /^\d+$/.test(direct)) return direct;
	const fid: string | null = dig(r, 10);
	if (fid && typeof fid === 'string') {
		const match = fid.match(/0x([0-9a-f]+)$/i);
		if (match) {
			try {
				return BigInt('0x' + match[1]).toString(10);
			} catch {
				// ignore
			}
		}
	}
	return null;
}

function extractKgmid(r: any): string | null {
	const s = JSON.stringify(r);
	const m = s.match('"(/g/[A-Za-z0-9_]+)"');
	return m ? m[1] : null;
}

function extractPrice(r: any): string | null {
	return dig(r, 4, 2) ?? null;
}

function extractClosedFlags(r: any): { permanentlyClosed: boolean; temporarilyClosed: boolean } {
	const code = dig(r, 88, 0);
	if (code === 2) return { permanentlyClosed: true, temporarilyClosed: false };
	if (code === 1) return { permanentlyClosed: false, temporarilyClosed: true };
	const s = JSON.stringify(r);
	const permClosed = s.includes('"Permanently closed"') || s.includes('"permanently_closed":true');
	const tempClosed = s.includes('"Temporarily closed"') || s.includes('"temporarily_closed":true');
	return { permanentlyClosed: permClosed, temporarilyClosed: tempClosed };
}

function extractOpeningHours(r: any): OpeningHour[] {
	const raw: any[] = dig(r, 34, 1) ?? [];
	if (!Array.isArray(raw)) return [];
	const out: OpeningHour[] = [];
	for (const entry of raw) {
		const inner = Array.isArray(entry) ? entry[1] : null;
		if (!Array.isArray(inner)) continue;
		const day: string = inner[0] ?? null;
		const hours: string = inner[1] ?? null;
		if (day && hours) out.push({ day, hours });
	}
	return out;
}

function extractReserveTableUrl(r: any): string | null {
	return dig(r, 75, 0, 5, 0) ?? dig(r, 75, 0, 2, 0) ?? null;
}

function extractImageUrl(r: any): string | null {
	return dig(r, 72, 0, 1, 6, 0) ?? dig(r, 72, 0, 3, 0, 0) ?? null;
}

function extractImagesCount(r: any): number | null {
	const v = dig(r, 37, 2);
	return typeof v === 'number' ? v : null;
}

function extractAdditionalInfo(r: any): AdditionalInfo {
	const sections: any[] = dig(r, 100, 1) ?? [];
	if (!Array.isArray(sections)) return {};
	const out: AdditionalInfo = {};
	for (const section of sections) {
		const sectionName: string = section?.[0];
		const attrs: any[] = section?.[1];
		if (!sectionName || !Array.isArray(attrs)) continue;
		out[sectionName] = attrs.map((attr: any) => {
			const attrName: string = attr?.[0] ?? '';
			const attrVal: boolean = attr?.[2] === 1 || attr?.[2] === true;
			return { [attrName]: attrVal };
		});
	}
	return out;
}

interface AddressParts {
	address: string | null;
	neighborhood: string | null;
	street: string | null;
	city: string | null;
	postalCode: string | null;
	state: string | null;
	countryCode: string | null;
	plusCode: string | null;
}

function extractAddressParts(r: any): AddressParts {
	const fullAddress: string | null = dig(r, 18) ?? dig(r, 39) ?? null;
	const components: any[] = dig(r, 183, 1, 1) ?? [];

	let neighborhood: string | null = null;
	let street: string | null = null;
	let city: string | null = null;
	let postalCode: string | null = null;
	let state: string | null = null;
	let countryCode: string | null = null;
	let plusCode: string | null = null;

	for (const comp of components) {
		if (!Array.isArray(comp)) continue;
		const value: string = comp[0];
		const type: string = comp[1] ?? '';
		switch (type) {
			case 'neighborhood': neighborhood = value; break;
			case 'route':        street       = value; break;
			case 'locality':     city         = value; break;
			case 'postal_code':  postalCode   = value; break;
			case 'admin1':       state        = value; break;
			case 'country':      countryCode  = value; break;
			case 'plus_code':    plusCode     = value; break;
		}
	}

	if (!city) city = dig(r, 14) ?? null;
	if (!postalCode) postalCode = dig(r, 160, 0) ?? null;

	return { address: fullAddress, neighborhood, street, city, postalCode, state, countryCode, plusCode };
}

function extractSubTitle(r: any): string | null {
	return dig(r, 167, 0) ?? null;
}

function extractLocatedIn(r: any): string | null {
	return dig(r, 93, 0, 0) ?? null;
}

function buildUrl(name: string | null, placeId: string | null): string | null {
	if (!name || !placeId) return null;
	return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${placeId}`;
}

// ============================================================
// MAIN RECORD PARSER
// ============================================================
function parseRecord(r: any, includeRaw: boolean, rank: number, scrapedAt: string): Place {
	const placeId = extractPlaceId(r);
	const name: string | null = dig(r, 11);
	const addr = extractAddressParts(r);
	const { permanentlyClosed, temporarilyClosed } = extractClosedFlags(r);

	const place: Place = {
		title:        name,
		subTitle:     extractSubTitle(r),
		description:  dig(r, 32, 1, 1) ?? null,
		categoryName: (dig(r, 13) as string[] | null)?.[0] ?? null,
		categories:   dig(r, 13) ?? null,
		placeId,
		fid:          dig(r, 10),
		cid:          extractCid(r),
		kgmid:        extractKgmid(r),

		phone:            extractPhone(r),
		phoneUnformatted: extractPhone(r),
		address:          addr.address,
		neighborhood:     addr.neighborhood,
		street:           addr.street,
		city:             addr.city,
		postalCode:       addr.postalCode,
		state:            addr.state,
		countryCode:      addr.countryCode,
		plusCode:         addr.plusCode,
		locatedIn:        extractLocatedIn(r),
		floor:            dig(r, 171, 0) ?? null,

		location: {
			lat: dig(r, 9, 2),
			lng: dig(r, 9, 3),
		},

		totalScore:   dig(r, 4, 7),
		reviewsCount: dig(r, 37, 1),
		reviewsTags:  [],

		imageUrl:        extractImageUrl(r),
		imagesCount:     extractImagesCount(r),
		imageCategories: [],

		price: extractPrice(r),

		permanentlyClosed,
		temporarilyClosed,
		claimThisBusiness: false,

		url:             buildUrl(name, placeId),
		website:         dig(r, 7, 0),
		website_domain:  dig(r, 7, 1),
		menu:            dig(r, 51, 0) ?? null,
		servicesLink:    null,
		reserveTableUrl: extractReserveTableUrl(r),
		googleFoodUrl:   dig(r, 75, 1, 0) ?? null,
		searchPageUrl:   null,
		searchString:    null,

		openingHours: extractOpeningHours(r),

		additionalInfo:          extractAdditionalInfo(r),
		popularTimesLiveText:    null,
		popularTimesLivePercent: null,
		popularTimesHistogram:   {},
		peopleAlsoSearch:        [],
		placesTags:              [],

		hotelStars:       dig(r, 52, 0) ?? null,
		hotelDescription: dig(r, 32, 1, 1) ?? null,
		checkInDate:      null,
		checkOutDate:     null,
		hotelAds:         [],
		gasPrices:        [],

		rank,
		isAdvertisement: false,
		language: 'en',
		scrapedAt,
	};

	if (includeRaw) place.raw_record = r;
	return place;
}

// ============================================================
// RESPONSE PARSER
// ============================================================
function parseResponse(text: string, includeRaw: boolean): Place[] {
	const scrapedAt = new Date().toISOString();
	try {
		const data = JSON.parse(stripXSSI(text));
		const containers: any[] = dig(data, 64) ?? [];
		const out: Place[] = [];
		let rank = 1;
		for (const c of containers) {
			const r = c?.[1];
			if (!Array.isArray(r) || r.length < 100) continue;
			const p = parseRecord(r, includeRaw, rank++, scrapedAt);
			if (p.fid && p.title) out.push(p);
		}
		return out;
	} catch {
		return [];
	}
}

// ============================================================
// CORE FETCH
// ============================================================
async function fetchPage(
	url: string,
	proxy: ProxyConfig,
	sessionId: string,
	timeoutMs: number,
): Promise<{ text: string; status: number; size: number }> {
	const httpAgent  = new http.Agent({ keepAlive: false });
	const httpsAgent = new https.Agent({ keepAlive: false });
	const ua = pickUserAgent();
	const proxyPassword = `${proxy.password}_country-${proxy.country}_session-${sessionId}`;

	const res: AxiosResponse = await axios.get(url, {
		headers: {
			'user-agent':      ua,
			accept:            '*/*',
			'accept-language': 'en-US,en;q=0.9',
			referer:           'https://www.google.com/maps/',
			cookie:            COOKIES,
		},
		proxy: {
			protocol: 'http',
			host:     proxy.host,
			port:     proxy.port,
			auth:     { username: proxy.username, password: proxyPassword },
		},
		httpAgent,
		httpsAgent,
		timeout:           timeoutMs,
		responseType:      'text',
		transformResponse: [(d: string) => d],
		validateStatus:    (s: number) => s >= 200 && s < 500,
	});

	const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
	return { text, status: res.status, size: text.length };
}

// ============================================================
// PAGINATION LOOP
// ============================================================
async function paginate(
	baseUrl:     string,
	maxResults:  number,
	proxy:       ProxyConfig,
	sessionId:   string,
	delayMs:     number,
	timeoutMs:   number,
	enableDebug: boolean,
	includeRaw:  boolean,
): Promise<PaginationResult> {
	const allPlaces = new Map<string, Place>();
	let lastOffset = 0;
	let stopReason = 'unknown';
	let pagesFetched = 0;
	const debugLog: string[] = [];

	const log = (msg: string) => { if (enableDebug) debugLog.push(`[${Date.now()}] ${msg}`); };

	log(`paginate start, maxResults=${maxResults}, session=${sessionId}`);

	for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_SIZE) {
		if (allPlaces.size >= maxResults) { stopReason = 'max_results_reached'; break; }

		let pageUrl = baseUrl;
		if (offset > 0) {
			// CRITICAL: use URL-encoded form (%21 = !) to match actual baseUrl format
			pageUrl = baseUrl.replace('%217i20%2110b1', `%217i20%218i${offset}%2110b1`);
			if (pageUrl === baseUrl) {
				stopReason = 'pagination_param_not_found';
				log('pagination param not found in baseUrl');
				break;
			}
		}

		let fetchResult: { text: string; status: number; size: number };
		try {
			fetchResult = await fetchPage(pageUrl, proxy, sessionId, timeoutMs);
			pagesFetched++;
			log(`offset=${offset} status=${fetchResult.status} size=${fetchResult.size}`);
		} catch (err: any) {
			const msg  = err?.message || String(err);
			const code = err?.code    || '';
			stopReason = `fetch_error: ${code ? code + ' ' : ''}${msg}`;
			log(`fetch failed at offset=${offset}: ${stopReason}`);
			break;
		}

		if (fetchResult.size < MIN_RESPONSE_SIZE) {
			stopReason = `cap_hit (response_size=${fetchResult.size}, http=${fetchResult.status})`;
			log(`cap_hit at offset=${offset}, size=${fetchResult.size}`);
			break;
		}

		const parsed = parseResponse(fetchResult.text, includeRaw);
		log(`offset=${offset} parsed=${parsed.length} places`);

		if (parsed.length === 0) { stopReason = 'empty_parse'; break; }

		let newCount = 0;
		for (const p of parsed) {
			if (!p.fid) continue;
			if (!allPlaces.has(p.fid)) { allPlaces.set(p.fid, p); newCount++; }
			if (allPlaces.size >= maxResults) break;
		}

		if (newCount === 0 && offset > 0) { stopReason = 'all_duplicates'; break; }

		lastOffset = offset;
		if (offset < MAX_OFFSET && allPlaces.size < maxResults) await sleep(delayMs);
	}

	if (stopReason === 'unknown') stopReason = 'loop_end';

	return {
		places:       Array.from(allPlaces.values()).slice(0, maxResults),
		lastOffset,
		stopReason,
		pagesFetched,
		debugLog,
	};
}

// ============================================================
// NODE DEFINITION
// ============================================================
export class GoogleMapsPaginator implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Maps Paginator',
		name:        'googleMapsPaginator',
		icon:        'file:googleMapsPaginator.svg',
		group:       ['transform'],
		version:     1,
		subtitle:    '={{$parameter["operation"]}}',
		description: 'Paginate Google Maps search results via configurable HTTP proxy',
		defaults:    { name: 'Google Maps Paginator' },
		inputs:      ['main'],
		outputs:     ['main'],
		credentials: [
			{
				name: 'evomiProxyApi',
				required: false,
				displayOptions: { show: { proxySource: ['credential'] } },
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name:        'operation',
				type:        'options',
				noDataExpression: true,
				options: [
					{
						name:        'Paginate Results',
						value:       'paginateResults',
						description: 'Loop through Google Maps result pages and parse places',
						action:      'Paginate results',
					},
				],
				default: 'paginateResults',
			},
			{ displayName: 'Base URL',    name: 'baseUrl',    type: 'string', default: '', required: true, description: 'Prefetch URL extracted from Google Maps HTML shell', placeholder: 'https://www.google.com/search?tbm=map&...' },
			{ displayName: 'Max Results', name: 'maxResults', type: 'number', default: DEFAULT_MAX_RESULTS, description: 'Maximum places to collect per viewport', typeOptions: { minValue: 1, maxValue: 500 } },
			{ displayName: 'Snapshot ID', name: 'snapshotId', type: 'string', default: '', description: 'Passthrough identifier for the parent job' },
			{ displayName: 'Cell',        name: 'cell',       type: 'string', default: 'auto', description: 'Passthrough grid cell identifier (e.g. r0c0)' },
			{ displayName: 'Latitude (passthrough)',  name: 'lat', type: 'string', default: '', description: 'Passthrough latitude, included in output' },
			{ displayName: 'Longitude (passthrough)', name: 'lng', type: 'string', default: '', description: 'Passthrough longitude, included in output' },
			{
				displayName: 'Proxy Source',
				name:        'proxySource',
				type:        'options',
				options: [
					{ name: 'Manual Input', value: 'manual',     description: 'Configure proxy in this node' },
					{ name: 'Credential',   value: 'credential', description: 'Use stored Evomi credential' },
				],
				default: 'manual',
			},
			{ displayName: 'Proxy Host',     name: 'proxyHost',     type: 'string', default: 'core-residential.evomi.com', required: true, displayOptions: { show: { proxySource: ['manual'] } } },
			{ displayName: 'Proxy Port',     name: 'proxyPort',     type: 'number', default: 1000, required: true, displayOptions: { show: { proxySource: ['manual'] } } },
			{ displayName: 'Proxy Username', name: 'proxyUsername', type: 'string', default: '', required: true, displayOptions: { show: { proxySource: ['manual'] } } },
			{ displayName: 'Proxy Password', name: 'proxyPassword', type: 'string', typeOptions: { password: true }, default: '', required: true, displayOptions: { show: { proxySource: ['manual'] } } },
			{ displayName: 'Proxy Country',  name: 'proxyCountry',  type: 'string', default: 'IN', required: true, displayOptions: { show: { proxySource: ['manual'] } } },
			{
				displayName: 'Advanced Options',
				name:        'advanced',
				type:        'collection',
				placeholder: 'Add Option',
				default:     {},
				options: [
					{ displayName: 'Delay Between Pages (ms)', name: 'delayMs',         type: 'number',  default: DEFAULT_DELAY_MS,  description: 'Sleep between paginated requests' },
					{ displayName: 'Request Timeout (ms)',     name: 'timeoutMs',        type: 'number',  default: DEFAULT_TIMEOUT_MS },
					{ displayName: 'Custom Session ID',        name: 'customSessionId', type: 'string',  default: '', description: 'Override auto-generated Evomi session ID' },
					{ displayName: 'Enable Debug Log',         name: 'enableDebug',     type: 'boolean', default: false, description: 'Whether to include per-page debug log in output stats' },
					{ displayName: 'Include Raw Record',       name: 'includeRaw',      type: 'boolean', default: false, description: 'Whether to attach the raw Google container array as raw_record on each place' },
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const startMs = Date.now();

			const baseUrl     = this.getNodeParameter('baseUrl',    i) as string;
			const maxResults  = this.getNodeParameter('maxResults', i, DEFAULT_MAX_RESULTS) as number;
			const snapshotId  = this.getNodeParameter('snapshotId', i, '') as string;
			const cell        = this.getNodeParameter('cell',       i, 'auto') as string;
			const lat         = this.getNodeParameter('lat',        i, '') as string;
			const lng         = this.getNodeParameter('lng',        i, '') as string;
			const proxySource = this.getNodeParameter('proxySource', i) as string;
			const advanced    = this.getNodeParameter('advanced', i, {}) as {
				delayMs?: number;
				timeoutMs?: number;
				customSessionId?: string;
				enableDebug?: boolean;
				includeRaw?: boolean;
			};

			let proxy: ProxyConfig;
			if (proxySource === 'credential') {
				const cred = await this.getCredentials('evomiProxyApi');
				proxy = {
					host:     cred.host     as string,
					port:     cred.port     as number,
					username: cred.username as string,
					password: cred.password as string,
					country:  cred.country  as string,
				};
			} else {
				proxy = {
					host:     this.getNodeParameter('proxyHost',     i) as string,
					port:     this.getNodeParameter('proxyPort',     i) as number,
					username: this.getNodeParameter('proxyUsername', i) as string,
					password: this.getNodeParameter('proxyPassword', i) as string,
					country:  this.getNodeParameter('proxyCountry',  i, 'IN') as string,
				};
			}

			if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.startsWith('https://')) {
				out.push({
					json: {
						snapshot_id: snapshotId, cell, lat, lng,
						ok: false, places_count: 0, places: [],
						stats: { raw_count: 0, last_offset: 0, stop_reason: 'invalid_base_url', seconds: 0, proxy_session: null, pages_fetched: 0 },
						error: `Invalid base_url: ${JSON.stringify(baseUrl).substring(0, 200)}`,
					},
					pairedItem: { item: i },
				});
				continue;
			}

			const sessionId   = advanced.customSessionId || generateSessionId();
			const delayMs     = advanced.delayMs    ?? DEFAULT_DELAY_MS;
			const timeoutMs   = advanced.timeoutMs  ?? DEFAULT_TIMEOUT_MS;
			const enableDebug = advanced.enableDebug ?? false;
			const includeRaw  = advanced.includeRaw  ?? false;

			let result: PaginationResult;
			let topLevelError: string | undefined;

			try {
				result = await paginate(baseUrl, maxResults, proxy, sessionId, delayMs, timeoutMs, enableDebug, includeRaw);
			} catch (err: any) {
				topLevelError = err?.message || String(err);
				result = {
					places:       [],
					lastOffset:   0,
					stopReason:   `top_level_error: ${topLevelError}`,
					pagesFetched: 0,
					debugLog:     [`exception: ${topLevelError}`, `stack: ${err?.stack || ''}`],
				};
			}

			const seconds = parseFloat(((Date.now() - startMs) / 1000).toFixed(2));

			const outputJson: any = {
				snapshot_id:  snapshotId,
				cell,
				lat,
				lng,
				ok:           result.places.length > 0,
				places_count: result.places.length,
				places:       result.places,
				stats: {
					raw_count:     result.places.length,
					last_offset:   result.lastOffset,
					stop_reason:   result.stopReason,
					seconds,
					proxy_session: sessionId,
					pages_fetched: result.pagesFetched,
				},
			};

			if (enableDebug)   outputJson.stats.debug_log = result.debugLog;
			if (topLevelError) outputJson.error = topLevelError;

			out.push({ json: outputJson, pairedItem: { item: i } });

			if (!outputJson.ok && !this.continueOnFail()) {
				throw new NodeOperationError(
					this.getNode(),
					`Pagination failed: ${result.stopReason}`,
					{ itemIndex: i },
				);
			}
		}

		return [out];
	}
}