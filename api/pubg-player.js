module.exports = async function handler(req, res) {
  const headers = { Accept: 'application/vnd.api+json', Authorization: 'Bearer ' + (process.env.PUBG_API_KEY || '') };
  const allowed = new Set(['steam', 'kakao', 'psn', 'xbox']);
  const playerName = String(req.query.playerName || '').trim();
  const platform = String(req.query.platform || 'steam').toLowerCase();
  if (!playerName || playerName.length > 32) return res.status(400).json({ code: 'INVALID_PLAYER', error: '플레이어 닉네임을 확인해주세요.' });
  if (!allowed.has(platform)) return res.status(400).json({ code: 'INVALID_PLATFORM', error: '지원하지 않는 플랫폼입니다.' });
  if (!process.env.PUBG_API_KEY) return res.status(503).json({ code: 'API_KEY_MISSING', error: 'PUBG API 키가 아직 설정되지 않았습니다.' });
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=300');
  const base = 'https://api.pubg.com/shards/' + platform;
  const get = async (url) => {
    const response = await fetch(url, { headers });
    if (response.status === 404) return null;
    if (response.status === 429) throw Object.assign(new Error('요청 한도에 도달했습니다. 잠시 후 다시 시도해주세요.'), { status: 429 });
    if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'PUBG API 키를 확인해주세요.' : 'PUBG 전적을 불러오지 못했습니다.'), { status: response.status });
    return response.json();
  };
  try {
    const searchUrl = base + '/players?' + new URLSearchParams({ 'filter[playerNames]': playerName });
    const found = await get(searchUrl);
    const player = found && found.data && found.data[0];
    if (!player) return res.status(404).json({ code: 'PLAYER_NOT_FOUND', error: '해당 플랫폼에서 플레이어를 찾지 못했습니다.' });
    const [seasons, ranked] = await Promise.all([
      get(base + '/seasons'),
      get(base + '/players/' + encodeURIComponent(player.id) + '/ranked')
    ]);
    const season = seasons?.data?.find(item => item.attributes?.isCurrentSeason);
    const seasonStats = season ? await get(base + '/players/' + encodeURIComponent(player.id) + '/seasons/' + encodeURIComponent(season.id)) : null;
    const stats = seasonStats?.data?.attributes?.gameModeStats || {};
    const choose = (...keys) => keys.map(key => stats[key]).find(Boolean) || {};
    const defs = [
      { key: 'solo', label: '솔로', stat: choose('solo', 'solo-fpp') },
      { key: 'duo', label: '듀오', stat: choose('duo', 'duo-fpp') },
      { key: 'squad', label: '스쿼드', stat: choose('squad', 'squad-fpp') }
    ];
    const modes = defs.map(({key,label,stat}) => {
      const games = Number(stat.roundsPlayed || 0), wins = Number(stat.wins || 0);
      return { key,label,kd: Number(stat.deaths) ? (Number(stat.kills||0)/Number(stat.deaths)).toFixed(2) : '0.00',
        winRate: games ? (wins/games*100).toFixed(1)+'%' : '0.0%', top10: games ? (Number(stat.top10s||0)/games*100).toFixed(1)+'%' : '0.0%',
        avgDamage: games ? Math.round(Number(stat.damageDealt||0)/games) : 0, games, avgRank: stat.avgRank ? Number(stat.avgRank).toFixed(1) : '—' };
    });
    const rankedModes = ranked?.data?.attributes?.rankedGameModeStats || {};
    const relations = player.relationships?.matches?.data || [];
    const mapNames = {Baltic_Main:'에란겔',Desert_Main:'미라마',Savage_Main:'사녹',DihorOtok_Main:'비켄디',Tiger_Main:'태이고',Chimera_Main:'파라모',Heaven_Main:'헤이븐',Kiki_Main:'데스턴',Neon_Main:'론도'};
    const matchData = await Promise.all(relations.slice(0,6).map(async item => {
      try {
        const match = await get(base + '/matches/' + encodeURIComponent(item.id));
        const participant = match?.included?.find(x => x.type === 'participant' && x.attributes?.stats?.playerId === player.id)?.attributes?.stats;
        if (!participant) return null;
        const duration = Number(participant.timeSurvived || 0);
        return { map: mapNames[match.data.attributes.mapName] || '전장', place: Number(participant.winPlace||0), duration: Math.floor(duration/60)+'분 '+String(Math.floor(duration%60)).padStart(2,'0')+'초',
          kills:Number(participant.kills||0), date:match.data.attributes.createdAt, mode:match.data.attributes.gameMode };
      } catch (_) { return null; }
    }));
    const allStats = defs.map(({key,stat}) => ({key,stat}));
    const sum = field => allStats.reduce((total,item)=>total+Number(item.stat[field]||0),0);
    const games = sum('roundsPlayed');
    const details = [
      {label:'헤드샷 비율',value:sum('kills') ? (sum('headshotKills')/sum('kills')*100).toFixed(1)+'%' : '0.0%'},
      {label:'평균 생존 시간',value:games ? Math.floor(sum('timeSurvived')/games/60)+'분 '+String(Math.floor(sum('timeSurvived')/games%60)).padStart(2,'0')+'초' : '—'},
      {label:'평균 어시스트',value:games ? (sum('assists')/games).toFixed(1) : '0.0'},
      {label:'기절 후 회복',value:String(sum('revives'))+'회'},
      {label:'치킨 횟수',value:String(sum('wins'))+'회'},
      {label:'최장 사거리',value:Math.round(Math.max(...allStats.map(x=>Number(x.stat.longestKill||0))))+'m'}
    ];
    return res.status(200).json({ player:{id:player.id,name:player.attributes.name,platform}, season:season?.id||'current', modes, details,
      matches:matchData.filter(Boolean), ranked:rankedModes });
  } catch (error) {
    return res.status(error.status || 502).json({ code: error.status===429?'RATE_LIMITED':'PUBG_API_ERROR', error:error.message||'PUBG API에 연결할 수 없습니다.' });
  }
};
