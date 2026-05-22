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

// Indian state name → ISO 3166-2:IN code lookup
const STATE_CODES: Record<string, string> = {
	'Andhra Pradesh':            'AP',
	'Arunachal Pradesh':         'AR',
	'Assam':                     'AS',
	'Bihar':                     'BR',
	'Chhattisgarh':              'CT',
	'Goa':                       'GA',
	'Gujarat':                   'GJ',
	'Haryana':                   'HR',
	'Himachal Pradesh':          'HP',
	'Jharkhand':                 'JH',
	'Karnataka':                 'KA',
	'Kerala':                    'KL',
	'Madhya Pradesh':            'MP',
	'Maharashtra':               'MH',
	'Manipur':                   'MN',
	'Meghalaya':                 'ML',
	'Mizoram':                   'MZ',
	'Nagaland':                  'NL',
	'Odisha':                    'OR',
	'Punjab':                    'PB',
	'Rajasthan':                 'RJ',
	'Sikkim':                    'SK',
	'Tamil Nadu':                'TN',
	'Telangana':                 'TG',
	'Tripura':                   'TR',
	'Uttar Pradesh':             'UP',
	'Uttarakhand':               'UT',
	'West Bengal':               'WB',
	'Andaman and Nicobar Islands':'AN',
	'Chandigarh':                'CH',
	'Dadra and Nagar Haveli and Daman and Diu': 'DH',
	'Delhi':                     'DL',
	'Jammu and Kashmir':         'JK',
	'Ladakh':                    'LA',
	'Lakshadweep':               'LD',
	'Puducherry':                'PY',
};

function lookupStateCode(state: string | null): string | null {
	if (!state) return null;
	return STATE_CODES[state.trim()] ?? null;
}

// Clean Google's internal type enum: "SearchResult.TYPE_INDIAN_RESTAURANT" → "indian restaurant"
function cleanType(raw: any): string | null {
	if (typeof raw !== 'string' || raw.length === 0) return null;
	return raw
		.replace(/^SearchResult\.TYPE_/, '')
		.replace(/_/g, ' ')
		.toLowerCase()
		.trim() || null;
}

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

interface Place {
	// Core
	fid: string | null;
	name: string | null;
	full_address: string | null;
	locality: string | null;
	latitude: number | null;
	longitude: number | null;
	rating: number | null;
	review_count: number | null;
	categories: string[] | null;
	website: string | null;
	website_domain: string | null;
	phone: string | null;
	place_id_cid: string | null;

	// Identity extras
	kgmid: string | null;
	cid: string | null;
	google_id: string | null;
	type: string | null;
	subtypes: string[] | null;
	verified: boolean;

	// Address decomposition
	street: string | null;
	city: string | null;
	state: string | null;
	state_code: string | null;
	postal_code: string | null;
	country_code: string | null;
	plus_code: string | null;
	timezone: string | null;

	// Pricing
	price_level: any;
	price_range: any;
	range: string | null;
	prices: any;

	// Images
	thumbnail: any;
	photo_count: any;
	main_image_url: string | null;
	photo: string | null;
	logo: string | null;
	street_view: string | null;

	// Hours
	hours: Record<string, string[]> | null;
	hours_csv: string | null;
	open_status: string | null;

	// Status
	permanently_closed: boolean;
	temporarily_closed: boolean;
	business_status: string;

	// Owner
	claimed: boolean;
	owner_id: string | null;
	owner_title: string | null;
	owner_link: string | null;

	// Links
	location_link: string | null;
	reviews_link: string | null;
	maps_url: string | null;
	menu_link: any;
	reservation_link: string | null;
	booking_link: any;
	booking_platforms: Array<{ name: string; url: string }> | null;
	order_links: Array<{ name: string; url: string }> | null;

	// Reviews
	reviews_per_score: Record<string, number> | null;

	// Rich attributes
	about: Record<string, Record<string, boolean>> | null;
	description: string | null;
	badges: string[];
	local_name: string | null;
	questions_answers: any;
	owner_response: any;

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

function extractFullAddress(r: any): string | null {
	return dig(r, 18) ?? dig(r, 39) ?? null;
}

// Phone — r[178][1][0][1] = international format, fallback to regex
function extractPhoneStructured(r: any): string | null {
	const intl = dig(r, 178, 1, 0, 1);
	if (intl && typeof intl === 'string') return intl.trim();
	return extractPhone(r);
}

// Hours — r[203] is array of 7 wrappers, each wrapper[0] is the day entry
// entry[0] = "Wednesday", entry[3][0][0] = "12 pm–12 am"
// Returns Outscraper-style: { "Wednesday": ["12 pm–12 am"], ... }
function extractHours(r: any): Record<string, string[]> | null {
	const raw = r[203];
	if (!Array.isArray(raw)) return null;
	const result: Record<string, string[]> = {};
	for (const wrapper of raw) {
		if (!Array.isArray(wrapper)) continue;
		const entry = wrapper[0];
		if (!Array.isArray(entry)) continue;
		const day   = entry[0];
		const hours = entry[3]?.[0]?.[0];
		if (typeof day === 'string' && typeof hours === 'string' && !result[day]) {
			result[day] = [hours];
		}
	}
	return Object.keys(result).length > 0 ? result : null;
}


// function extractHours(r: any): Record<string, string[]> | null {
// 	// Try r[203] first
// 	const raw = r[203];
// 	if (Array.isArray(raw)) {
// 		const result: Record<string, string[]> = {};
// 		for (const wrapper of raw) {
// 			if (!Array.isArray(wrapper)) continue;
// 			const entry = wrapper[0];
// 			if (!Array.isArray(entry)) continue;
// 			const day   = entry[0];
// 			const hours = entry[3]?.[0]?.[0];
// 			if (typeof day === 'string' && typeof hours === 'string' && !result[day]) {
// 				result[day] = [hours];
// 			}
// 		}
// 		if (Object.keys(result).length > 0) return result;
// 	}
// 	// Fallback: r[118] session-based hours (first session only)
// 	const sessions = r[118];
// 	if (!Array.isArray(sessions)) return null;
// 	const result: Record<string, string[]> = {};
// 	const days = sessions[0]?.[3]?.[0];
// 	if (!Array.isArray(days)) return null;
// 	for (const entry of days) {
// 		if (!Array.isArray(entry)) continue;
// 		const day   = entry[0];
// 		const hours = entry[3]?.[0]?.[0];
// 		if (typeof day === 'string' && typeof hours === 'string' && !result[day]) {
// 			result[day] = [hours];
// 		}
// 	}
// 	return Object.keys(result).length > 0 ? result : null;
// }

// About/attributes — r[100][1]
function extractAbout(r: any): Record<string, Record<string, boolean>> | null {
	const sections: any[] = dig(r, 100, 1) ?? [];
	if (!Array.isArray(sections) || sections.length === 0) return null;
	const out: Record<string, Record<string, boolean>> = {};
	for (const section of sections) {
		const sectionName: string = section?.[1];
		const attrs: any[] = section?.[2];
		if (!sectionName || !Array.isArray(attrs)) continue;
		out[sectionName] = {};
		for (const attr of attrs) {
			const attrName: string = attr?.[1];
			const attrVal: boolean = attr?.[2]?.[0] === 1;
			if (attrName) out[sectionName][attrName] = attrVal;
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}

// Badges — r[196][1]: LGBTQ+ friendly, women-owned, etc.
function extractBadges(r: any): string[] {
	const items: any[] = dig(r, 196, 1) ?? [];
	if (!Array.isArray(items)) return [];
	const out: string[] = [];
	for (const item of items) {
		const label = dig(item, 1, 0);
		if (label && typeof label === 'string') out.push(label);
	}
	return out;
}

// Order links — r[46]: Swiggy, Zomato, District etc.
function extractOrderLinks(r: any): Array<{ name: string; url: string }> | null {
	const raw: any[] = dig(r, 46) ?? [];
	if (!Array.isArray(raw)) return null;
	const out: Array<{ name: string; url: string }> = [];
	for (const item of raw) {
		const url  = dig(item, 0);
		const name = dig(item, 1);
		if (url && name) out.push({ name, url });
	}
	return out.length > 0 ? out : null;
}

// Booking platforms — r[75][0][0]
function extractBookingPlatforms(r: any): Array<{ name: string; url: string }> | null {
	const raw: any[] = dig(r, 75, 0, 0) ?? [];
	if (!Array.isArray(raw)) return null;
	const out: Array<{ name: string; url: string }> = [];
	for (const platform of raw) {
		const name = dig(platform, 0);
		const url  = dig(platform, 2, 0);
		if (name && url) out.push({ name, url });
	}
	return out.length > 0 ? out : null;
}

// Reservation link — r[75][0][0][i][2][0] across booking platforms; first non-null wins
function extractReservationLink(r: any): string | null {
	const raw: any[] = dig(r, 75, 0, 0) ?? [];
	if (!Array.isArray(raw)) return null;
	for (const item of raw) {
		const url = dig(item, 2, 0);
		if (url && typeof url === 'string') return url;
	}
	return null;
}

// Owner info — r[57]
function extractOwner(r: any): { id: string | null; title: string | null; link: string | null } {
	const ownerCid = dig(r, 57, 2);
	return {
		id:    dig(r, 57, 8) ?? ownerCid,
		title: dig(r, 57, 1),
		link:  ownerCid ? `https://www.google.com/maps?cid=${ownerCid}` : null,
	};
}

// // Address decomposition — r[183][3][1]
// function extractAddressComponents(r: any): {
// 	street: string | null;
// 	city: string | null;
// 	state: string | null;
// 	postal_code: string | null;
// 	country_code: string | null;
// } {
// 	const comp = dig(r, 183, 3, 1);
// 	return {
// 		street:       Array.isArray(comp) ? (comp[1] ?? null) : null,
// 		city:         Array.isArray(comp) ? (comp[3] ?? null) : null,
// 		state:        Array.isArray(comp) ? (comp[5] ?? null) : null,
// 		postal_code:  Array.isArray(comp) ? (comp[4] ?? null) : null,
// 		country_code: Array.isArray(comp) ? (comp[6] ?? null) : null,
// 	};
// }

// Address decomposition
// r[82] = ["locality","street","street","city"] — street + city always present
// r[2] last element = "City, State PIN" — state + postal
function extractAddressComponents(r: any): {
	street: string | null;
	city: string | null;
	state: string | null;
	postal_code: string | null;
	country_code: string | null;
} {
	const r82: any[] = r[82] ?? [];
	const r2: any[]  = r[2]  ?? [];

	const street = r82[1] ?? null;
	const city   = r82[3] ?? null;

	const lastPart: string = (Array.isArray(r2) ? r2[r2.length - 1] : null) ?? '';
	let state: string | null = null;
	let postal: string | null = null;
	if (typeof lastPart === 'string' && lastPart.length > 0) {
		const postalMatch = lastPart.match(/\b(\d{6})\b/);
		postal = postalMatch ? postalMatch[1] : null;
		const parts = lastPart.split(',');
		if (parts.length >= 2) {
			state = parts[1].replace(/\b\d{6}\b/, '').trim() || null;
		}
	}

	const comp = dig(r, 183, 3, 1);
	const country_code = dig(r, 243)
		?? (Array.isArray(comp) ? comp[6] : null)
		?? null;

	return { street, city, state, postal_code: postal, country_code };
}

// Location link
function buildLocationLink(name: string | null, fid: string | null): string | null {
	if (!name || !fid) return null;
	return `https://www.google.com/maps/place/${encodeURIComponent(name)}/@0,0,14z/data=!4m5!3m4!1s${fid}!8m2!3d0!4d0`;
}

// Reviews link
function buildReviewsLink(placeId: string | null): string | null {
	if (!placeId) return null;
	return `https://search.google.com/local/reviews?placeid=${placeId}&authuser=0&hl=en&gl=IN`;
}

// Maps URL — built from fid
function buildMapsUrl(name: string | null, fid: string | null): string | null {
	if (!fid) return null;
	if (name) return `https://www.google.com/maps/search/${encodeURIComponent(name)}/@0,0,14z/data=!4m2!3m1!1s${fid}`;
	return `https://www.google.com/maps/place/?q=place_id:${fid}`;
}

// Reviews per score — r[88][4] buckets: 5,4,3,2,1 star order
function extractReviewsPerScore(r: any): Record<string, number> | null {
	const bucket = dig(r, 88, 4);
	if (Array.isArray(bucket) && bucket.length >= 5) {
		return {
			'5': bucket[0] ?? 0,
			'4': bucket[1] ?? 0,
			'3': bucket[2] ?? 0,
			'2': bucket[3] ?? 0,
			'1': bucket[4] ?? 0,
		};
	}
	return null;
}

// ============================================================
// RECORD PARSER
// ============================================================
function parseRecord(r: any, includeRaw: boolean): Place {
	const fid      = dig(r, 10);
	const name     = dig(r, 11);
	const placeId  = extractPlaceId(r);
	const owner    = extractOwner(r);
	const addr     = extractAddressComponents(r);
	const hoursObj = extractHours(r);

	// hours_csv: "Wednesday,12 pm–12 am|Thursday,12 pm–12 am|..."
	const hoursCsv = hoursObj
		? Object.entries(hoursObj).map(([d, h]) => `${d},${h[0]}`).join('|')
		: null;

	// open_status — r[203][1][4][0]: "Open · Closes 12 am"
	const openStatus = r[203]?.[1]?.[4]?.[0] ?? null;

	const place: Place = {
		// ── Core identity ──────────────────────────────────────
		fid,
		name,
		place_id_cid:   placeId,
		kgmid:          dig(r, 89),
		cid:            dig(r, 57, 2) ?? dig(r, 227, 5) ?? dig(r, 227, 6),
		google_id:      fid,
		type:           cleanType(dig(r, 88, 1)),
		subtypes:       dig(r, 13),
		verified:       dig(r, 61) === true || dig(r, 61) === 1,

		// ── Contact ────────────────────────────────────────────
		phone:          extractPhoneStructured(r),
		website:        dig(r, 7, 0),
		website_domain: dig(r, 7, 1),

		// ── Location ───────────────────────────────────────────
		latitude:       dig(r, 9, 2),
		longitude:      dig(r, 9, 3),
		full_address:   extractFullAddress(r),
		locality:       dig(r, 14),
		street:         addr.street,
		city:           addr.city,
		state:          addr.state,
		state_code:     lookupStateCode(addr.state),
		postal_code:    addr.postal_code,
		country_code:   addr.country_code ?? dig(r, 243),
		plus_code:      dig(r, 183, 0, 0, 0),
		timezone:       dig(r, 30),

		// ── Categories ─────────────────────────────────────────
		categories:     dig(r, 13),

		// ── Ratings ────────────────────────────────────────────
		rating:             dig(r, 4, 7),
		review_count:       dig(r, 37, 1),
		reviews_per_score:  extractReviewsPerScore(r),


		// ── Pricing ────────────────────────────────────────────
		price_level: dig(r, 4, 2),
		price_range: dig(r, 4, 10),
		range:       dig(r, 4, 2),
		prices:      dig(r, 4, 10),

		// ── Images ─────────────────────────────────────────────
		main_image_url: dig(r, 72, 0, 0, 6, 0),
		photo:          dig(r, 72, 0, 0, 6, 0),
		thumbnail:      dig(r, 37, 0),
		photo_count:    dig(r, 37, 8),
		logo:           dig(r, 157),
		street_view:    dig(r, 72, 0, 0, 6, 0),

		// ── Hours ──────────────────────────────────────────────
		hours:       hoursObj,
		hours_csv:   hoursCsv,
		open_status: openStatus,

		// ── Status ─────────────────────────────────────────────
		permanently_closed: dig(r, 88, 0) === 2,
		temporarily_closed: dig(r, 88, 0) === 1,
		business_status:    dig(r, 88, 0) === 2 ? 'PERMANENTLY_CLOSED'
		                  : dig(r, 88, 0) === 1 ? 'TEMPORARILY_CLOSED'
		                  : 'OPERATIONAL',

		// ── Owner / claimed ────────────────────────────────────
		claimed:     owner.title != null,
		owner_id:    owner.id,
		owner_title: owner.title,
		owner_link:  owner.link,

		// ── Links ──────────────────────────────────────────────
		location_link:     buildLocationLink(name, fid),
		maps_url:          buildMapsUrl(name, fid),
		reviews_link:      buildReviewsLink(placeId),
		menu_link:         dig(r, 38, 0),
		reservation_link:  extractReservationLink(r),
		booking_link:      dig(r, 75, 0, 0, 2, 0),
		booking_platforms: extractBookingPlatforms(r),
		order_links:       extractOrderLinks(r),

		// ── Rich attributes ────────────────────────────────────
		about:          extractAbout(r),
		description:    dig(r, 88, 3),
		badges:         extractBadges(r),
		local_name:     dig(r, 101),

		// ── Misc ───────────────────────────────────────────────
		questions_answers: dig(r, 142),
		owner_response:    dig(r, 144),
	};

	if (includeRaw) place.raw_record = r;
	return place;
}

// ============================================================
// RESPONSE PARSER
// ============================================================
function parseResponse(text: string, includeRaw: boolean): Place[] {
	try {
		const data = JSON.parse(stripXSSI(text));
		const containers: any[] = dig(data, 64) ?? [];
		const out: Place[] = [];
		for (const c of containers) {
			const r = c?.[1];
			if (!Array.isArray(r) || r.length < 100) continue;
			const p = parseRecord(r, includeRaw);
			if (p.fid && p.name) out.push(p);
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