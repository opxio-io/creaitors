// Vercel Serverless Function — Deals Won/Lost
// Queries Sales CRM - Pipeline for closed deals (Won & Lost)
// Environment variables: NOTION_API_KEY

const DATABASE_ID = process.env.NOTION_DATABASE_ID || '3188b289e31a81da8939cb08d15be667';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  try {
    const NOTION_KEY = process.env.NOTION_API_KEY;
    if (!NOTION_KEY) return res.status(500).json({ error: 'NOTION_API_KEY not set' });

    const headers = {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    async function queryAll(filter) {
      let all = [], hasMore = true, cursor;
      while (hasMore) {
        const body = { page_size: 100 };
        if (filter) body.filter = filter;
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
          method: 'POST', headers, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`DB query error (${r.status}): ${await r.text()}`);
        const d = await r.json();
        all = all.concat(d.results);
        hasMore = d.has_more;
        cursor = d.next_cursor;
      }
      return all;
    }

    const getTitle      = p => p?.type === 'title' ? (p.title || []).map(t => t.plain_text).join('') : '';
    const getStatus     = p => p?.type === 'status' ? p.status?.name : null;
    const getNumber     = p => p?.type === 'number' ? (p.number || 0) : 0;
    const getSelect     = p => p?.type === 'select' ? p.select?.name : null;
    const getText       = p => p?.type === 'rich_text' ? (p.rich_text || []).map(t => t.plain_text).join('') : '';
    const getMultiSelect = p => p?.type === 'multi_select' ? (p.multi_select || []).map(s => s.name) : [];

    const deals = await queryAll();
    const now = new Date();
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthLabel = months[now.getMonth()] + ' ' + now.getFullYear();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const wonDeals = [];
    const lostDeals = [];
    let wonTotal = 0, wonTotalValue = 0, wonThisMonth = 0, wonThisMonthValue = 0;
    let lostTotal = 0, lostTotalValue = 0, lostThisMonth = 0, lostThisMonthValue = 0;
    const wonSourceMap = {};
    const lostReasonMap = {};

    for (const page of deals) {
      const props = page.properties;
      const funnel = getStatus(props['Funnel']);
      if (!funnel) continue;

      const name    = getTitle(props['Name']);
      const value   = getNumber(props['Estimated Value']);
      const source  = getSelect(props['Source']);
      const company = getText(props['PIC Name']) || '';
      const reasons = getMultiSelect(props['Why Not Closing?']);
      const created = new Date(page.created_time);
      const isThisMonth = created.getMonth() === currentMonth && created.getFullYear() === currentYear;

      if (funnel === 'Closed-Won') {
        wonTotal++;
        wonTotalValue += value;
        if (isThisMonth) { wonThisMonth++; wonThisMonthValue += value; }

        wonDeals.push({ name, company, value, source: source || null, url: page.url });

        if (source) {
          if (!wonSourceMap[source]) wonSourceMap[source] = { label: source, value: 0, count: 0 };
          wonSourceMap[source].value += value;
          wonSourceMap[source].count++;
        }
      }

      if (funnel === 'Closed-Lost') {
        lostTotal++;
        lostTotalValue += value;
        if (isThisMonth) { lostThisMonth++; lostThisMonthValue += value; }

        const reason = reasons.length > 0 ? reasons.join(', ') : 'No reason given';
        lostDeals.push({ name, company, value, reason, url: page.url });

        for (const r of reasons) {
          if (!lostReasonMap[r]) lostReasonMap[r] = { label: r, value: 0, count: 0 };
          lostReasonMap[r].value += value;
          lostReasonMap[r].count++;
        }
        if (reasons.length === 0) {
          const key = 'No reason given';
          if (!lostReasonMap[key]) lostReasonMap[key] = { label: key, value: 0, count: 0 };
          lostReasonMap[key].value += value;
          lostReasonMap[key].count++;
        }
      }
    }

    // Sort deals by value descending
    wonDeals.sort((a, b) => b.value - a.value);
    lostDeals.sort((a, b) => b.value - a.value);

    const wonBreakdown = Object.values(wonSourceMap).sort((a, b) => b.value - a.value);
    const lostBreakdown = Object.values(lostReasonMap).sort((a, b) => b.value - a.value);

    return res.status(200).json({
      monthLabel,
      won: {
        total: wonTotal,
        totalValue: wonTotalValue,
        thisMonth: wonThisMonth,
        thisMonthValue: wonThisMonthValue,
        deals: wonDeals,
        breakdown: wonBreakdown,
      },
      lost: {
        total: lostTotal,
        totalValue: lostTotalValue,
        thisMonth: lostThisMonth,
        thisMonthValue: lostThisMonthValue,
        deals: lostDeals,
        breakdown: lostBreakdown,
      },
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
