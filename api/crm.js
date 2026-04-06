// Vercel Serverless Function — Sales CRM Overview
// Queries Sales CRM - Pipeline for funnel, source, follow-ups, revenue
// Supports ?from=YYYY-MM-DD&to=YYYY-MM-DD date filtering for revenue
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

    // Parse date range from query
    const url = new URL(req.url, `https://${req.headers.host}`);
    const fromDate = url.searchParams.get('from');
    const toDate = url.searchParams.get('to');

    // Determine month label
    let monthLabel = '';
    if (fromDate) {
      const d = new Date(fromDate + 'T00:00:00');
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      monthLabel = months[d.getMonth()] + ' ' + d.getFullYear();
    } else {
      const now = new Date();
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      monthLabel = months[now.getMonth()] + ' ' + now.getFullYear();
    }

    // Paginated query
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

    // Property helpers
    const getTitle    = p => p?.type === 'title' ? (p.title || []).map(t => t.plain_text).join('') : '';
    const getStatus   = p => p?.type === 'status' ? p.status?.name : null;
    const getNumber   = p => p?.type === 'number' ? (p.number || 0) : 0;
    const getSelect   = p => p?.type === 'select' ? p.select?.name : null;
    const getDate     = p => p?.type === 'date' ? p.date?.start : null;
    const getText     = p => p?.type === 'rich_text' ? (p.rich_text || []).map(t => t.plain_text).join('') : '';
    const getCheckbox = p => p?.type === 'checkbox' ? p.checkbox : false;

    const deals = await queryAll();
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Determine date range for "this month" revenue
    let rangeStart, rangeEnd;
    if (fromDate && toDate) {
      rangeStart = fromDate;
      rangeEnd = toDate;
    } else {
      const y = now.getFullYear(), m = now.getMonth();
      rangeStart = `${y}-${String(m + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(y, m + 1, 0).getDate();
      rangeEnd = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }

    // Funnel stages order
    const FUNNEL_ORDER = ['Lead', 'Contacted', 'Qualified', 'Proposal Sent', 'Negotiation'];
    const funnelMap = {};
    FUNNEL_ORDER.forEach(s => { funnelMap[s] = { stage: s, count: 0, value: 0 }; });

    const sourceCounts = {};
    let totalActiveLeads = 0;
    let totalPipelineValue = 0;
    let revenueThisMonth = 0;
    let wonThisMonth = 0;
    let lostThisMonth = 0;
    let totalWonAllTime = 0;
    let totalLostAllTime = 0;
    const overdueFollowups = [];
    const todayFollowups = [];
    const weekFollowups = [];
    const staleLeads = [];
    const unpaidRetainer = [];
    const unpaidKol = [];

    // Week boundary (7 days from today)
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEndStr = weekEnd.toISOString().slice(0, 10);

    // Stale threshold: 7 days
    const staleThreshold = new Date(now);
    staleThreshold.setDate(staleThreshold.getDate() - 7);
    const staleStr = staleThreshold.toISOString().slice(0, 10);

    for (const page of deals) {
      const props = page.properties;
      const funnel     = getStatus(props['Funnel']);
      const name       = getTitle(props['Name']);
      const value      = getNumber(props['Estimated Value']);
      const source     = getSelect(props['Source']);
      const followUp   = getDate(props['Next Follow-up']);
      const lastContact = getDate(props['Last Contacted']);
      const company    = getText(props['PIC Name']) || '';
      const retainerPaid = getCheckbox(props['Retainer Paid (100%)']);
      const kolPaid      = getCheckbox(props['KOL/Ads Deposit Paid (50%)']);

      if (!funnel) continue;

      // Active leads (not closed)
      if (funnel !== 'Closed-Won' && funnel !== 'Closed-Lost') {
        totalActiveLeads++;
        totalPipelineValue += value;

        // Funnel breakdown
        if (funnelMap[funnel]) {
          funnelMap[funnel].count++;
          funnelMap[funnel].value += value;
        }

        // Source breakdown
        if (source) {
          sourceCounts[source] = (sourceCounts[source] || 0) + 1;
        }

        // Follow-up tracking
        if (followUp) {
          if (followUp < todayStr) {
            overdueFollowups.push({ name, company, funnel, date: followUp });
          } else if (followUp === todayStr) {
            todayFollowups.push({ name, company, funnel, date: followUp });
          } else if (followUp <= weekEndStr) {
            weekFollowups.push({ name, company, funnel, date: followUp });
          }
        }

        // Stale leads (not contacted in 7+ days or never)
        if (!lastContact || lastContact <= staleStr) {
          staleLeads.push({
            name,
            company,
            funnel,
            lastContacted: lastContact || 'Never',
          });
        }
      }

      // Closed-Won
      if (funnel === 'Closed-Won') {
        totalWonAllTime++;
        // Check if created/won within date range
        const created = page.created_time.slice(0, 10);
        if (created >= rangeStart && created <= rangeEnd) {
          wonThisMonth++;
          revenueThisMonth += value;
        }
        // Unpaid tracking
        if (!retainerPaid && value > 0) {
          unpaidRetainer.push({ name, company, value });
        }
        if (!kolPaid && value > 0) {
          unpaidKol.push({ name, company, value });
        }
      }

      // Closed-Lost
      if (funnel === 'Closed-Lost') {
        totalLostAllTime++;
        const created = page.created_time.slice(0, 10);
        if (created >= rangeStart && created <= rangeEnd) {
          lostThisMonth++;
        }
      }
    }

    // Win rate
    const totalClosed = totalWonAllTime + totalLostAllTime;
    const winRate = totalClosed > 0 ? Math.round((totalWonAllTime / totalClosed) * 100) : 0;

    // Sort follow-ups by date
    overdueFollowups.sort((a, b) => a.date.localeCompare(b.date));
    todayFollowups.sort((a, b) => a.date.localeCompare(b.date));
    weekFollowups.sort((a, b) => a.date.localeCompare(b.date));
    staleLeads.sort((a, b) => {
      if (a.lastContacted === 'Never') return -1;
      if (b.lastContacted === 'Never') return 1;
      return a.lastContacted.localeCompare(b.lastContacted);
    });

    const funnelBreakdown = FUNNEL_ORDER.map(s => funnelMap[s]);
    const sourceBreakdown = Object.entries(sourceCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return res.status(200).json({
      monthLabel,
      totalActiveLeads,
      totalPipelineValue,
      revenueThisMonth,
      wonThisMonth,
      lostThisMonth,
      winRate,
      totalWonAllTime,
      totalLostAllTime,
      funnelBreakdown,
      overdueFollowups,
      todayFollowups,
      weekFollowups,
      staleLeads,
      repBreakdown: [],
      sourceBreakdown,
      unpaidRetainer,
      unpaidKol,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
