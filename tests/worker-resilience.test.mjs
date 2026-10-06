import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const workerPath = fileURLToPath(new URL('../_worker.js', import.meta.url));
const workerSource = await readFile(workerPath, 'utf8');

function createSandbox(fetchImpl = async () => { throw new Error('Unexpected network request in test'); }) {
	const logged = [];
	const cryptoShim = {
		getRandomValues: array => webcrypto.getRandomValues(array),
		randomUUID: () => webcrypto.randomUUID(),
		subtle: {
			digest: async (algorithm, data) => {
				if (String(algorithm).toUpperCase() === 'MD5') {
					const digest = Uint8Array.from(createHash('md5').update(Buffer.from(data)).digest());
					return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
				}
				return webcrypto.subtle.digest(algorithm, data);
			},
		},
	};
	const sandbox = vm.createContext({
		AbortController,
		Blob,
		CompressionStream,
		DecompressionStream,
		FormData,
		Headers,
		ReadableStream,
		Request,
		Response,
		TextDecoder,
		TextEncoder,
		TransformStream,
		URL,
		URLSearchParams,
		WebSocket,
		WritableStream,
		atob,
		btoa,
		clearInterval,
		clearTimeout,
		crypto: cryptoShim,
		fetch: fetchImpl,
		performance,
		queueMicrotask,
		setInterval,
		setTimeout,
		clearTimeout,
		console: {
			log: (...args) => logged.push(['log', ...args]),
			warn: (...args) => logged.push(['warn', ...args]),
			error: (...args) => logged.push(['error', ...args]),
		},
	});
	const exportsForTest = `
	globalThis.__worker = globalThis.__worker || null;
	globalThis.__helpers = {
		创建请求连接设置,
		读取config_JSON,
		读取受限请求文本,
		获取外部响应内容,
		获取外部JSON,
		获取管理页面,
		getCloudflareUsage,
		匹配白名单域名,
		请求优选API,
		生成随机IP,
		合并配置默认值,
		规范化Cloudflare用量,
		安全错误摘要,
		隐去日志URL,
		解析CloudflareTrace,
		MD5MD5,
		请求连接设置,
		默认请求连接设置,
	};
	`;
	const transformed = workerSource.replace('export default {', 'globalThis.__worker = {') + exportsForTest;
	vm.runInContext(transformed, sandbox, { filename: '_worker.js', timeout: 10_000 });
	return { sandbox, helpers: sandbox.__helpers, worker: sandbox.__worker, logged };
}

function makeKV(config, { malformed = false } = {}) {
	const values = new Map([
		['config.json', malformed ? '{ definitely not json' : config],
		['tg.json', JSON.stringify({ BotToken: null, ChatID: null })],
		['cf.json', JSON.stringify({ Email: null, GlobalAPIKey: null, AccountID: null, APIToken: null, UsageAPI: null })],
	]);
	return {
		get: async key => values.get(key) ?? null,
		put: async (key, value) => values.set(key, value),
	};
}

function makeCloudflareRequest(url) {
	const request = new Request(url);
	request.cf = { colo: 'YUL', country: 'CN', asn: 9808, asOrganization: 'China Mobile' };
	return request;
}

test('deep-merges stale KV config and isolates concurrent request snapshots', async () => {
	const { helpers } = createSandbox();
	const envA = { KV: makeKV(JSON.stringify({ 优选订阅生成: { SUBNAME: 'alpha' } })) };
	const envB = { KV: makeKV(JSON.stringify({ 优选订阅生成: { SUBNAME: 'beta' }, SS: { TLS: true } })) };
	const [configA, configB] = await Promise.all([
		helpers.读取config_JSON(envA, 'alpha.example', '11111111-1111-4111-8111-111111111111', 'client-a'),
		helpers.读取config_JSON(envB, 'beta.example', '22222222-2222-4222-8222-222222222222', 'client-b'),
	]);

	assert.equal(configA.HOST, 'alpha.example');
	assert.equal(configA.优选订阅生成.SUBNAME, 'alpha');
	assert.equal(configA.SS.TLS, false, 'legacy configs without SS retain the old no-TLS fallback');
	assert.equal(configB.HOST, 'beta.example');
	assert.equal(configB.优选订阅生成.SUBNAME, 'beta');
	assert.equal(configB.SS.TLS, true);
	assert.equal(configA.UUID, '11111111-1111-4111-8111-111111111111');
	assert.equal(configB.UUID, '22222222-2222-4222-8222-222222222222');
	assert.ok(configA.反代 && configA.反代.SOCKS5 && configA.反代.路径模板, 'missing nested KV sections receive defaults');
});

test('malformed config KV returns a complete default instead of throwing', async () => {
	const { helpers } = createSandbox();
	const config = await helpers.读取config_JSON(
		{ KV: makeKV(null, { malformed: true }) },
		'worker.example',
		'33333333-3333-4333-8333-333333333333',
	);
	assert.equal(config.HOST, 'worker.example');
	assert.equal(config.UUID, '33333333-3333-4333-8333-333333333333');
	assert.equal(config.优选订阅生成.本地IP库.随机数量, 16);
	assert.equal(config.CF.Usage.success, false);
});

test('oversized config KV falls back to defaults before JSON parsing', async () => {
	const { helpers } = createSandbox();
	const largeConfig = `{"extension":"${'x'.repeat(1024 * 1024)}"}`;
	const config = await helpers.读取config_JSON(
		{ KV: makeKV(largeConfig) },
		'bounded.example',
		'77777777-7777-4777-8777-777777777777',
	);
	assert.equal(config.HOST, 'bounded.example');
	assert.ok(config.反代 && config.优选订阅生成.本地IP库);
});

test('stored config copying caps nested data depth instead of overflowing the Worker stack', () => {
	const { helpers } = createSandbox();
	const deepValue = {};
	let cursor = deepValue;
	for (let index = 0; index < 1000; index++) cursor = cursor.next = {};
	const merged = helpers.合并配置默认值({ extension: {} }, { extension: { deepValue } });
	let copied = merged.extension.deepValue;
	for (let index = 0; index < 64; index++) copied = copied.next;
	assert.equal(copied.next, null);
});

test('request dial settings are isolated and bounded', async () => {
	const { helpers } = createSandbox();
	const mobileRequest = makeCloudflareRequest('https://worker.example/');
	const mobileSettings = await helpers.创建请求连接设置({
		GO2SOCKS5: 'media.example,*.preferred.test',
		PRELOAD_RACE_DIAL: 'true',
	}, mobileRequest);
	const explicitSettings = await helpers.创建请求连接设置({
		TCP_CONCURRENT_DIAL: '50',
		PROXY_CONCURRENT_DIAL: '18',
	}, makeCloudflareRequest('https://worker.example/'));

	assert.equal(mobileSettings.TCP并发拨号数, 1, 'default mobile carrier behavior is retained');
	assert.equal(mobileSettings.反代并发拨号数, 1);
	assert.equal(mobileSettings.预加载竞速拨号, true);
	assert.ok(mobileSettings.SOCKS5白名单.includes('media.example'));
	assert.equal(explicitSettings.TCP并发拨号数, 16);
	assert.equal(explicitSettings.反代并发拨号数, 16);
	assert.equal(helpers.默认请求连接设置.TCP并发拨号数, 2, 'request settings do not mutate defaults');

	const isolated = createSandbox(async () => new Response('<main>ok</main>', { headers: { 'Content-Type': 'text/html' } }));
	const requestA = makeCloudflareRequest('https://worker.example/version');
	const requestB = new Request('https://worker.example/version');
	requestB.cf = { colo: 'YUL', country: 'US', asn: 7922, asOrganization: 'Comcast' };
	const context = { waitUntil() {} };
	await Promise.all([
		isolated.worker.fetch(requestA, { UUID: '77777777-7777-4777-8777-777777777777', TCP_CONCURRENT_DIAL: '3', URL: 'https://camouflage.example' }, context),
		isolated.worker.fetch(requestB, { UUID: '88888888-8888-4888-8888-888888888888', URL: 'https://camouflage.example' }, context),
	]);
	assert.equal(isolated.helpers.请求连接设置.get(requestA).TCP并发拨号数, 3);
	assert.equal(isolated.helpers.请求连接设置.get(requestB).TCP并发拨号数, 2);
});

test('SOCKS5 whitelist treats only asterisks as wildcards and rejects malformed patterns safely', () => {
	const { helpers } = createSandbox();
	assert.equal(helpers.匹配白名单域名('media.example.com', ['*.example.com']), true);
	assert.equal(helpers.匹配白名单域名('evilxexample.com', ['example.com']), false);
	assert.equal(helpers.匹配白名单域名('anything.example', ['[malformed']), false);
	assert.equal(helpers.匹配白名单域名('', ['*']), false);
});

test('cross-origin camouflage fetch does not forward browser credentials', async () => {
	let outboundHeaders;
	const { worker } = createSandbox(async (_input, init) => {
		outboundHeaders = new Headers(init.headers);
		return new Response('<p>camouflage</p>', { headers: { 'Content-Type': 'text/html' } });
	});
	const request = makeCloudflareRequest('https://worker.example/about');
	request.headers.set('Cookie', 'auth=synthetic-cookie; session=synthetic-session');
	request.headers.set('Authorization', 'Bearer synthetic-token');
	request.headers.set('Proxy-Authorization', 'Basic synthetic-proxy-token');
	request.headers.set('CF-Access-Jwt-Assertion', 'synthetic-access-assertion');
	request.headers.set('CF-Access-Client-Id', 'synthetic-access-client-id');
	request.headers.set('CF-Access-Client-Secret', 'synthetic-access-client-secret');
	request.headers.set('X-API-Key', 'synthetic-api-key');
	request.headers.set('X-API-Token', 'synthetic-api-token');
	request.headers.set('X-Auth-Token', 'synthetic-auth-token');
	request.headers.set('X-Access-Token', 'synthetic-access-token');
	const response = await worker.fetch(request, {
		ADMIN: 'synthetic-admin',
		UUID: '99999999-9999-4999-8999-999999999999',
		URL: 'https://camouflage.example',
	}, { waitUntil() {} });

	assert.equal(response.status, 200);
	for (const header of ['cookie', 'authorization', 'proxy-authorization', 'cf-access-jwt-assertion', 'cf-access-client-id', 'cf-access-client-secret', 'x-api-key', 'x-api-token', 'x-auth-token', 'x-access-token']) {
		assert.equal(outboundHeaders.has(header), false, `${header} must not cross to another origin`);
	}
});

test('Cloudflare trace parsing accepts only plain IPs and two-letter locations', () => {
	const { helpers } = createSandbox();
	assert.deepEqual(
		JSON.parse(JSON.stringify(helpers.解析CloudflareTrace('fl=12\nip=203.0.113.7\nloc=ca\n'))),
		{ ip: '203.0.113.7', loc: 'CA' },
	);
	assert.deepEqual(
		JSON.parse(JSON.stringify(helpers.解析CloudflareTrace('ip=2606:4700:4700::1111\nloc=US\n'))),
		{ ip: '2606:4700:4700::1111', loc: 'US' },
	);
	assert.throws(() => helpers.解析CloudflareTrace('ip=<img src=x>\nloc=<svg/onload=alert(1)>'));
	assert.throws(() => helpers.解析CloudflareTrace('ip=203.0.113.7\nloc=<b>US</b>'));
});

test('admin proxy-check failures do not echo proxy credentials and are not cached', async () => {
	const { worker, helpers } = createSandbox();
	const admin = 'proxy-check-auth-test';
	const userAgent = 'proxy-check-test-client';
	const key = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';
	const auth = await helpers.MD5MD5(userAgent + key + admin);
	const proxy = 'synthetic-user-secret@proxy.example';
	const request = makeCloudflareRequest(`https://worker.example/admin/check?socks5=${encodeURIComponent(proxy)}`);
	request.headers.set('Cookie', `auth=${auth}`);
	request.headers.set('User-Agent', userAgent);
	const response = await worker.fetch(request, {
		ADMIN: admin,
		UUID: '44444444-4444-4444-8444-444444444444',
		KV: makeKV('{}'),
	}, { waitUntil() {} });

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const payload = await response.json();
	assert.equal(payload.success, false);
	assert.equal(payload.error, 'Proxy check failed');
	assert.equal('proxy' in payload, false);
	assert.ok(!JSON.stringify(payload).includes('synthetic-user-secret'));
	assert.ok(!JSON.stringify(payload).includes('proxy.example'));
});

test('external response helper limits both time and bytes', async () => {
	const { sandbox, helpers } = createSandbox(async () => new Response(new Uint8Array([1, 2, 3, 4])));
	await assert.rejects(
		helpers.获取外部响应内容('https://upstream.example/data', {}, 100, 3),
		/size limit/i,
	);

	sandbox.fetch = (_input, init) => new Promise((_, reject) => {
		init.signal.addEventListener('abort', () => reject(new Error('aborted by test timeout')), { once: true });
	});
	await assert.rejects(
		helpers.获取外部响应内容('https://upstream.example/slow', {}, 10, 64),
		/aborted by test timeout/,
	);

	sandbox.fetch = async () => new Response('bounded and complete');
	const { response, body } = await helpers.获取外部响应内容('https://upstream.example/ok', {}, 100, 64);
	assert.equal(response.status, 200);
	assert.equal(new TextDecoder().decode(body), 'bounded and complete');
});

test('preferred API reads and parses have bounded fan-out, source count, and row count', async () => {
	let active = 0, maxActive = 0;
	const requested = [];
	const { sandbox, helpers } = createSandbox(async input => {
		active++;
		maxActive = Math.max(maxActive, active);
		requested.push(String(input));
		await new Promise(resolve => setTimeout(resolve, 2));
		active--;
		const sourceIndex = Number(String(input).split('/').at(-1));
		return new Response(`node-${sourceIndex}.preferred.test:443`);
	});

	const sources = Array.from({ length: 24 }, (_, index) => `https://api.example/${index}`);
	const [nodes] = await helpers.请求优选API(sources, '443', 1000);
	assert.equal(requested.length, 16, 'only the first bounded set of configured sources is fetched');
	assert.ok(maxActive <= 4, 'no more than four third-party reads run concurrently');
	assert.equal(nodes.length, 16);

	sandbox.fetch = async () => new Response(Array.from({ length: 5000 }, (_, index) => `node-${index}.preferred.test:443`).join('\n'));
	const [boundedRows] = await helpers.请求优选API(['https://api.example/large'], '443', 1000);
	assert.equal(boundedRows.length, 4096, 'only a bounded number of response rows are materialized');

	sandbox.fetch = async () => new Response(btoa('192.0.2.1:8443#one\n192.0.2.2:8443#two'));
	const [decodedBase64Nodes] = await helpers.请求优选API(['https://api.example/base64'], '443', 1000);
	assert.deepEqual(JSON.parse(JSON.stringify(decodedBase64Nodes)), ['192.0.2.1:8443#one', '192.0.2.2:8443#two']);
});

test('preferred IP generator falls back safely and keeps valid non-443 ports', async () => {
	const { sandbox, helpers } = createSandbox(async () => new Response('not-a-cidr\n999.1.1.1/24\n192.0.2.0/99'));
	const request = makeCloudflareRequest('https://worker.example/sub?cnIspCode=cf');
	const [fallbackNodes] = await helpers.生成随机IP(request, 3, 2053);
	assert.equal(fallbackNodes.length, 3);
	assert.ok(fallbackNodes.every(node => /^104\.(?:1[6-9]|2[0-3])\.\d{1,3}\.\d{1,3}:2053#CF Official Preferred \d+$/.test(node)));
	assert.ok(fallbackNodes.every(node => !node.startsWith('127.0.0.1:')));

	sandbox.fetch = async () => new Response('10.20.0.0/16\nthis is malformed');
	const [mobileNodes] = await helpers.生成随机IP(makeCloudflareRequest('https://worker.example/sub?cnIspCode=cmcc'), 2, 2083);
	assert.ok(mobileNodes.every(node => /^10\.20\.\d{1,3}\.\d{1,3}:2083#CF China Mobile Preferred \d+$/.test(node)));

	const [unicomNodes] = await helpers.生成随机IP(makeCloudflareRequest('https://worker.example/sub?cnIspCode=cu'), 1, 443);
	assert.match(unicomNodes[0], /#CF China Unicom Preferred 1$/);
	const [telecomNodes] = await helpers.生成随机IP(makeCloudflareRequest('https://worker.example/sub?cnIspCode=ct'), 1, 8443);
	assert.match(telecomNodes[0], /:8443#CF China Telecom Preferred 1$/);

	sandbox.fetch = async () => new Response('', { status: 503 });
	const [boundedCount] = await helpers.生成随机IP(request, 1000, -1);
	assert.equal(boundedCount.length, 99, 'local generation honors the admin UI’s 1–99 range');
	assert.ok(boundedCount.every(node => /:(?:443|2053|2083|2087|2096|8443)#CF Official Preferred \d+$/.test(node)));
});

test('admin request-body reader enforces size limits and preserves text formatting', async () => {
	const { helpers } = createSandbox();
	const text = '104.16.0.1:443#custom\r\nsub://example.test';
	const request = new Request('https://worker.example/admin/ADD.txt', { method: 'POST', body: text });
	assert.equal(await helpers.读取受限请求文本(request, 1024), text);

	const oversized = new Request('https://worker.example/admin/ADD.txt', { method: 'POST', body: '12345' });
	await assert.rejects(helpers.读取受限请求文本(oversized, 4), error => error.status === 413);
});

test('request URLs are redacted before persistent/admin log exposure', () => {
	const { helpers } = createSandbox();
	assert.equal(helpers.隐去日志URL('https://worker.example/sub?token=subscription-secret&target=clash'), 'https://worker.example/sub');
	assert.equal(helpers.隐去日志URL('https://worker.example/video/encoded-proxy-credentials?ed=2560'), 'https://worker.example/video/[redacted]');
	assert.equal(helpers.隐去日志URL('https://worker.example/44444444-4444-4444-8444-444444444444'), 'https://worker.example/[redacted]');
	assert.equal(helpers.隐去日志URL('https://worker.example/private-key-route', { KEY: 'private-key-route' }), 'https://worker.example/[redacted]');
	assert.equal(helpers.隐去日志URL('https://worker.example/admin/config.json?token=secret'), 'https://worker.example/admin/config.json');
	assert.equal(helpers.安全错误摘要('Authorization: Bearer demo-token X-AUTH-KEY=demo-key AccountID=demo-account'), 'Authorization=[redacted] X-AUTH-KEY=[redacted] AccountID=[redacted]');
	assert.equal(helpers.安全错误摘要('client_secret=demo-secret\nCF-Access-Jwt-Assertion=demo-jwt'), 'client_secret=[redacted] CF-Access-Jwt-Assertion=[redacted]');
});


test('authenticated admin proxy forwards only the external UI supported lite parameter', async () => {
	const requestedURLs = [];
	const { worker, helpers } = createSandbox(async input => {
		requestedURLs.push(String(input));
		return new Response('<!doctype html><title>Admin</title>', {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	});
	const admin = 'admin-ui-query-test';
	const userAgent = 'admin-ui-query-client';
	const key = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';
	const auth = await helpers.MD5MD5(userAgent + key + admin);
	const request = makeCloudflareRequest('https://worker.example/admin?lite=1&noise=drop-me');
	request.headers.set('Cookie', `auth=${auth}`);
	request.headers.set('User-Agent', userAgent);
	const response = await worker.fetch(request, {
		ADMIN: admin,
		UUID: '66666666-6666-4666-8666-666666666666',
		OFF_LOG: '1',
		KV: makeKV('{}'),
	}, { waitUntil() {} });

	assert.equal(response.status, 200);
	assert.ok(requestedURLs.includes('https://edt-pages.github.io/admin?lite=1'));
	assert.ok(!requestedURLs.some(url => url.includes('noise=')));
});

test('admin interface fetch fails closed with a retryable status', async () => {
	const { sandbox, helpers } = createSandbox(async () => { throw new Error('upstream offline'); });
	const failed = await helpers.获取管理页面('/admin');
	assert.equal(failed.status, 503);
	assert.match(await failed.text(), /temporarily unavailable/i);

	sandbox.fetch = async () => new Response('<!doctype html><title>Admin</title>', {
		status: 200,
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
	const loaded = await helpers.获取管理页面('/login');
	assert.equal(loaded.status, 200);
	assert.equal(loaded.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, proxy-revalidate');
	assert.match(await loaded.text(), /Admin/);
});

test('Cloudflare usage fetches are bounded, numeric and degrade to zero usage', async () => {
	const calls = [];
	const { sandbox, helpers } = createSandbox(async (input, init = {}) => {
		calls.push({ input: String(input), init });
		if (String(input).endsWith('/accounts')) {
			return new Response(JSON.stringify({ result: [{ id: 'account-1', name: 'owner@example.test' }] }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return new Response(JSON.stringify({ data: { viewer: { accounts: [{
			pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 7 } }],
			workersInvocationsAdaptive: [{ sum: { requests: '5' } }],
		}] } } }), { headers: { 'Content-Type': 'application/json' } });
	});
	const normalized = helpers.规范化Cloudflare用量({ success: true, pages: '7', workers: 5, total: null, max: '' });
	assert.deepEqual(JSON.parse(JSON.stringify(normalized)), { success: true, pages: 7, workers: 5, total: 12, max: 100000 });
	const usage = await helpers.getCloudflareUsage('owner@example.test', 'test-key', null, null);
	assert.equal(usage.success, true);
	assert.equal(usage.pages, 7);
	assert.equal(usage.workers, 5);
	assert.equal(usage.total, 12);
	assert.equal(usage.max, 100000);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].init.headers['X-AUTH-KEY'], 'test-key');
	assert.ok(calls[1].init.signal, 'the GraphQL request has a bounded abort signal');

	sandbox.fetch = async () => { throw new Error('upstream unavailable'); };
	const fallback = await helpers.getCloudflareUsage(null, null, 'account-1', 'test-token');
	assert.deepEqual(JSON.parse(JSON.stringify(fallback)), { success: false, pages: 0, workers: 0, total: 0, max: 100000 });
});

test('credential-bearing Cloudflare usage GET is authenticated, no-store, and not added to KV logs', async () => {
	const cloudflareCalls = [];
	const { worker, helpers } = createSandbox(async (input, init = {}) => {
		cloudflareCalls.push({ input: String(input), init });
		if (String(input).endsWith('/accounts')) {
			return new Response(JSON.stringify({ result: [{ id: 'account-usage-test', name: 'owner@example.test' }] }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return new Response(JSON.stringify({ data: { viewer: { accounts: [{
			pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 4 } }],
			workersInvocationsAdaptive: [{ sum: { requests: 6 } }],
		}] } } }), { headers: { 'Content-Type': 'application/json' } });
	});
	const admin = 'usage-route-auth-test';
	const userAgent = 'usage-route-test-client';
	const key = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';
	const auth = await helpers.MD5MD5(userAgent + key + admin);
	const kv = makeKV('{}');
	const request = makeCloudflareRequest('https://worker.example/admin/getCloudflareUsage?Email=owner%40example.test&GlobalAPIKey=synthetic-global-key&AccountID=&APIToken=');
	request.headers.set('Cookie', `auth=${auth}`);
	request.headers.set('User-Agent', userAgent);
	const response = await worker.fetch(request, {
		ADMIN: admin,
		UUID: '33333333-3333-4333-8333-333333333333',
		KV: kv,
	}, { waitUntil() {} });

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const payload = await response.json();
	assert.equal(payload.success, true);
	assert.equal(payload.total, 10);
	assert.ok(!JSON.stringify(payload).includes('synthetic-global-key'));
	assert.equal(cloudflareCalls.length, 2);
	assert.equal(cloudflareCalls[0].init.headers['X-AUTH-KEY'], 'synthetic-global-key');
	assert.equal(await kv.get('log.json'), null, 'the credential-bearing incoming URL is not persisted in the Worker log KV');
});

test('authenticated config route survives corrupt KV state end-to-end', async () => {
	const { worker, helpers } = createSandbox();
	const admin = 'unit-test-admin';
	const userAgent = 'resilience-test-client';
	const key = '勿动此默认密钥，有需求请自行通过添加变量KEY进行修改';
	const auth = await helpers.MD5MD5(userAgent + key + admin);
	const request = makeCloudflareRequest('https://worker.example/admin/config.json');
	request.headers.set('Cookie', `auth=${auth}`);
	request.headers.set('User-Agent', userAgent);
	const response = await worker.fetch(request, {
		ADMIN: admin,
		UUID: '55555555-5555-4555-8555-555555555555',
		OFF_LOG: '1',
		KV: makeKV(null, { malformed: true }),
	}, { waitUntil() {} });
	assert.equal(response.status, 200);
	const config = await response.json();
	assert.equal(config.UUID, '55555555-5555-4555-8555-555555555555');
	assert.ok(config.反代 && config.优选订阅生成.本地IP库);
});

test('unexpected request exceptions produce a controlled response', async () => {
	const { worker } = createSandbox();
	const response = await worker.fetch(new Request('https://worker.example/'), undefined, { waitUntil() {} });
	assert.equal(response.status, 500);
	assert.equal(await response.text(), 'Internal Worker Error');
});
