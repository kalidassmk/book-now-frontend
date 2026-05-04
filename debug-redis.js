/**
 * debug-redis.js
 * Run: node debug-redis.js
 * Dumps all Redis keys + the content of fast-move hashes
 */
const Redis = require('ioredis');
const redis = new Redis({ host: '127.0.0.1', port: 6379 });

async function main() {
    console.log('\n══════════════════════════════════════════════');
    console.log(' REDIS DEBUG DUMP');
    console.log('══════════════════════════════════════════════\n');

    const allKeys = await redis.keys('*');

    if (allKeys.length === 0) {
        console.log('❌ Redis is EMPTY — no keys at all!');
        console.log('   → Spring Boot pipeline is NOT writing to Redis.');
        console.log('   → Check if the Spring Boot service is actually running and started.');
    } else {
        console.log(`✅ Found ${allKeys.length} key(s):\n`);
        for (const key of allKeys.sort()) {
            const type = await redis.type(key);
            if (type === 'hash') {
                const len = await redis.hlen(key);
                console.log(`  [HASH] "${key}"  →  ${len} field(s)`);
                if (len > 0 && len <= 5) {
                    const data = await redis.hgetall(key);
                    for (const [field, val] of Object.entries(data)) {
                        const short = val.length > 120 ? val.substring(0, 120) + '…' : val;
                        console.log(`         ${field}: ${short}`);
                    }
                } else if (len > 5) {
                    const data = await redis.hgetall(key);
                    const fields = Object.keys(data).slice(0, 3);
                    console.log(`         (showing 3 of ${len}): ${fields.join(', ')} …`);
                }
            } else {
                const val = await redis.get(key);
                console.log(`  [${type.toUpperCase()}] "${key}" = ${String(val).substring(0, 80)}`);
            }
        }
    }

    // Specifically check the keys the dashboard reads
    console.log('\n══════════════════════════════════════════════');
    console.log(' KEY MATCH CHECK (server.js constants vs Redis)');
    console.log('══════════════════════════════════════════════\n');
    const expected = [
        'FAST_MOVE',
        'LT2MIN_0>3',
        'ULTRA_FAST0>2',
        'ULTRA_FAST2>3',
        'ULTRA_FAST0>3',
        'CURRENT_PRICE',
        'BUY',
        'SELL',
    ];
    for (const k of expected) {
        const exists = allKeys.includes(k);
        const len = exists ? await redis.hlen(k) : 0;
        console.log(`  ${exists ? (len > 0 ? '✅' : '⚠️ empty') : '❌ missing'} "${k}"  (${len} entries)`);
    }

    // Show any key that looks like fast-move but didn't match
    const fastLike = allKeys.filter(k =>
        k.includes('FAST') || k.includes('LT2') || k.includes('ULTRA') || k.includes('MOVE')
    );
    if (fastLike.length > 0) {
        console.log('\n  ── Fast-move-like keys actually in Redis:');
        for (const k of fastLike) {
            const len = await redis.hlen(k);
            console.log(`     "${k}"  (${len} entries)`);
        }
    }

    console.log('\n══════════════════════════════════════════════\n');
    redis.quit();
}

main().catch(e => { console.error('Error:', e.message); redis.quit(); });
