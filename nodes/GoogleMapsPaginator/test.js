// test.js
const r = [  
  
  
  
  
  
  
  
  
"4152325809601159265",
  
  
  
  
  
  
  
  
  
"-7214466714719576236"
  
  
  
  
  
  
  
  
],
  
  
  
  
  
  
  
  
0.75,
  
  
  
  
  
  
  
  
[
  
  
  
  
  
  
  
  
  
[
  
  
  
  
  
  
  
  
  
  
"Western Uttar Pradesh"
  
  
]
  
]
  
  
  
  
  
  
  
]
  
  
  
  
  
  
]
  
  
  
  
  
],
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
null,
  
  
  
  
  
1,
  
  
  
  
  
0
  
  
  
  
]
  
  
  
}
  
  
],];

function dig(obj, ...keys) {
    let cur = obj;
    for (const k of keys) {
        if (cur == null || typeof cur !== 'object') return null;
        cur = cur[k];
    }
    return cur ?? null;
}

function extractHours(r) {
    const raw = dig(r, 203, 0, 0);
    if (!Array.isArray(raw)) return null;
    const seen = new Set();
    const out = [];
    for (const entry of raw) {
        const day   = dig(entry, 0);
        const hours = dig(entry, 3, 0, 0);
        if (typeof day === 'string' && hours && !seen.has(day)) {
            seen.add(day);
            out.push({ day, hours });
        }
    }
    return out.length > 0 ? out : null;
}

const result = {
    fid:          dig(r, 10),
    name:         dig(r, 11),
    phone:        dig(r, 178, 1, 0, 1),
    website:      dig(r, 7, 0),
    rating:       dig(r, 4, 7),
    review_count: dig(r, 37, 1),
    hours:        extractHours(r),
    open_status:  dig(r, 203, 0, 1, 4, 0),
    city:         dig(r, 183, 3, 1, 3),
    state:        dig(r, 183, 3, 1, 5),
    // add whatever field you're testing
};

console.log(JSON.stringify(result, null, 2));