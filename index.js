const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const MAIN_URL = "https://api.streamflix.app";
const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive"
};

let configData = null;

// Get configuration
async function getConfig() {
    if (!configData) {
        try {
            const response = await axios.get(`${MAIN_URL}/config/config-streamflixapp.json`, {
                headers: DEFAULT_HEADERS,
                timeout: 30000
            });
            configData = response.data;
        } catch (error) {
            console.error('Error fetching config:', error.message);
            // Fallback config
            configData = {
                movies: ["https://example.com/fallback/"],
                tv: ["https://example.com/fallback/"],
                premium: ["https://example.com/fallback/"],
                download: ["https://example.com/fallback/"],
                latest: 1,
                banner: "",
                video: "",
                newapp: false,
                notice: false,
                title: "Fallback",
                text: "Using fallback configuration"
            };
        }
    }
    return configData;
}

// WebSocket extractor for episodes
async function getEpisodesFromWebSocket(movieKey, totalSeasons = 1) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log('WebSocket timeout');
            resolve({});
        }, 30000);

        const ws = new WebSocket('wss://chilflix-410be-default-rtdb.asia-southeast1.firebasedatabase.app/.ws?ns=chilflix-410be-default-rtdb&v=5');
        
        let seasonsData = {};
        let currentSeason = 1;
        let seasonsCompleted = 0;
        let messageBuffer = '';

        ws.on('open', () => {
            console.log('WebSocket opened, requesting season', currentSeason);
            
            const requestData = {
                t: "d",
                d: {
                    a: "q",
                    r: currentSeason,
                    b: {
                        p: `Data/${movieKey}/seasons/${currentSeason}/episodes`,
                        h: ""
                    }
                }
            };
            
            ws.send(JSON.stringify(requestData));
        });

        ws.on('message', (data) => {
            const text = data.toString();
            
            // Check if this is just a number
            try {
                const number = parseInt(text.trim());
                if (!isNaN(number)) {
                    return;
                }
            } catch (e) {}
            
            messageBuffer += text;
            
            try {
                const jsonObject = JSON.parse(messageBuffer);
                messageBuffer = '';
                
                if (jsonObject.t === "d" && jsonObject.d) {
                    const data = jsonObject.d;
                    
                    // Check for completion status
                    if (data.r && data.b && data.b.s === "ok") {
                        seasonsCompleted++;
                        console.log(`Season ${currentSeason} complete (${seasonsCompleted}/${totalSeasons})`);
                        
                        if (seasonsCompleted < totalSeasons) {
                            currentSeason++;
                            const requestData = {
                                t: "d",
                                d: {
                                    a: "q",
                                    r: currentSeason,
                                    b: {
                                        p: `Data/${movieKey}/seasons/${currentSeason}/episodes`,
                                        h: ""
                                    }
                                }
                            };
                            ws.send(JSON.stringify(requestData));
                        } else {
                            clearTimeout(timeout);
                            ws.close();
                            resolve(seasonsData);
                        }
                        return;
                    }
                    
                    if (data.b && data.b.d) {
                        const episodes = data.b.d;
                        const path = data.b.p || '';
                        const seasonMatch = path.match(/seasons\/(\\d+)\/episodes/);
                        const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : currentSeason;
                        
                        const episodeMap = {};
                        Object.entries(episodes).forEach(([key, value]) => {
                            try {
                                episodeMap[parseInt(key)] = value;
                            } catch (e) {
                                console.error('Error parsing episode:', e.message);
                            }
                        });
                        
                        if (Object.keys(episodeMap).length > 0) {
                            if (!seasonsData[seasonNumber]) {
                                seasonsData[seasonNumber] = {};
                            }
                            Object.assign(seasonsData[seasonNumber], episodeMap);
                            console.log(`Added ${Object.keys(episodeMap).length} episodes for season ${seasonNumber}`);
                        }
                    }
                }
            } catch (e) {
                // JSON parsing failed, continue buffering
                if (messageBuffer.length > 100000) {
                    console.error('Message too large, clearing buffer');
                    messageBuffer = '';
                    clearTimeout(timeout);
                    ws.close();
                    resolve({});
                }
            }
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error.message);
            clearTimeout(timeout);
            resolve({});
        });

        ws.on('close', () => {
            clearTimeout(timeout);
            resolve(seasonsData);
        });
    });
}

// API Routes

// Get main page content
app.get('/api/home', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const response = await axios.get(`${MAIN_URL}/data.json`, {
            headers: DEFAULT_HEADERS,
            timeout: 30000
        });

        const data = response.data;
        
        const movies = data.data
            .filter(item => !item.isTV && item.moviename && item.moviename.trim())
            .slice(offset, offset + limit)
            .map(item => ({
                name: item.moviename,
                url: `${item.moviekey}|movie`,
                type: 'movie',
                posterUrl: item.movieposter ? `https://image.tmdb.org/t/p/w500/${item.movieposter}` : null,
                year: item.movieyear ? parseInt(item.movieyear) : null,
                rating: item.movierating || 0,
                quality: 'HD'
            }));

        const tvShows = data.data
            .filter(item => item.isTV && item.moviename && item.moviename.trim())
            .slice(offset, offset + limit)
            .map(item => ({
                name: item.moviename,
                url: `${item.moviekey}|tv`,
                type: 'tv',
                posterUrl: item.movieposter ? `https://image.tmdb.org/t/p/w500/${item.movieposter}` : null,
                year: item.movieyear ? parseInt(item.movieyear) : null,
                rating: item.movierating || 0,
                quality: 'HD'
            }));

        const totalMovies = data.data.filter(item => !item.isTV && item.moviename && item.moviename.trim()).length;
        const totalTvShows = data.data.filter(item => item.isTV && item.moviename && item.moviename.trim()).length;

        res.json({
            success: true,
            data: {
                movies: {
                    items: movies,
                    pagination: {
                        currentPage: page,
                        totalItems: totalMovies,
                        totalPages: Math.ceil(totalMovies / limit),
                        hasNext: offset + limit < totalMovies,
                        hasPrev: page > 1
                    }
                },
                tvShows: {
                    items: tvShows,
                    pagination: {
                        currentPage: page,
                        totalItems: totalTvShows,
                        totalPages: Math.ceil(totalTvShows / limit),
                        hasNext: offset + limit < totalTvShows,
                        hasPrev: page > 1
                    }
                }
            }
        });

    } catch (error) {
        console.error('Error in /api/home:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch home content',
            message: error.message
        });
    }
});

// Search content
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        if (!query) {
            return res.status(400).json({
                success: false,
                error: 'Query parameter "q" is required'
            });
        }

        const response = await axios.get(`${MAIN_URL}/data.json`, {
            headers: DEFAULT_HEADERS,
            timeout: 30000
        });

        const data = response.data;
        
        const filteredItems = data.data.filter(item => 
            item.moviename && item.moviename.trim() &&
            (item.moviename.toLowerCase().includes(query.toLowerCase()) ||
            (item.movietype && item.movietype.toLowerCase().includes(query.toLowerCase())) ||
            (item.movieinfo && item.movieinfo.toLowerCase().includes(query.toLowerCase())))
        );

        const paginatedItems = filteredItems.slice(offset, offset + limit);

        const searchResults = paginatedItems.map(item => ({
            name: item.moviename,
            url: `${item.moviekey}|${item.isTV ? 'tv' : 'movie'}`,
            type: item.isTV ? 'tv' : 'movie',
            posterUrl: item.movieposter ? `https://image.tmdb.org/t/p/w500/${item.movieposter}` : null,
            year: item.movieyear ? parseInt(item.movieyear) : null,
            rating: item.movierating || 0,
            quality: 'HD',
            description: item.moviedesc || '',
            genre: item.movieinfo || ''
        }));

        res.json({
            success: true,
            data: {
                results: searchResults,
                pagination: {
                    currentPage: page,
                    totalItems: filteredItems.length,
                    totalPages: Math.ceil(filteredItems.length / limit),
                    hasNext: offset + limit < filteredItems.length,
                    hasPrev: page > 1
                },
                query: query
            }
        });

    } catch (error) {
        console.error('Error in /api/search:', error.message);
        res.status(500).json({
            success: false,
            error: 'Search failed',
            message: error.message
        });
    }
});

// Get content details
app.get('/api/content/:id', async (req, res) => {
    try {
        const url = req.params.id;
        const [movieKey, type] = url.split('|');

        if (movieKey === "error") {
            return res.json({
                success: false,
                error: 'Content not available',
                message: 'The StreamFlix service is currently unavailable'
            });
        }

        const response = await axios.get(`${MAIN_URL}/data.json`, {
            headers: DEFAULT_HEADERS,
            timeout: 30000
        });

        const data = response.data;
        const item = data.data.find(i => i.moviekey === movieKey);

        if (!item) {
            return res.status(404).json({
                success: false,
                error: 'Content not found'
            });
        }

        const movieName = item.moviename && item.moviename.trim() ? item.moviename : 'Unknown Title';

        let contentData = {
            name: movieName,
            url: url,
            type: item.isTV ? 'tv' : 'movie',
            posterUrl: item.movieposter ? `https://image.tmdb.org/t/p/w500/${item.movieposter}` : null,
            backgroundPosterUrl: item.moviebanner ? `https://image.tmdb.org/t/p/original/${item.moviebanner}` : null,
            year: item.movieyear ? parseInt(item.movieyear) : null,
            plot: item.moviedesc || '',
            tags: item.movieinfo ? item.movieinfo.split('/') : [],
            rating: item.movierating ? Math.round(item.movierating * 1000) : 0,
            duration: item.movieduration || '',
            trailer: item.movietrailer || '',
            imdb: item.movieimdb || '',
            tmdb: item.tmdb || '',
            views: item.movieviews || 0
        };

        if (item.isTV) {
            // Extract season count
            const seasonCount = item.movieduration ? 
                (item.movieduration.match(/(\\d+)\\s+Season/)?.[1] ? parseInt(item.movieduration.match(/(\\d+)\\s+Season/)[1]) : 1) : 1;
            
            console.log(`TV Show has ${seasonCount} seasons`);
            const episodesData = await getEpisodesFromWebSocket(movieKey, seasonCount);
            
            const episodes = [];
            Object.entries(episodesData).forEach(([seasonNumber, episodesMap]) => {
                Object.entries(episodesMap).forEach(([episodeKey, episodeData]) => {
                    episodes.push({
                        name: episodeData.name || `Episode ${parseInt(episodeKey) + 1}`,
                        season: parseInt(seasonNumber),
                        episode: parseInt(episodeKey) + 1,
                        description: episodeData.overview || '',
                        posterUrl: episodeData.still_path ? `https://image.tmdb.org/t/p/w500/${episodeData.still_path}` : null,
                        rating: episodeData.vote_average ? Math.round(episodeData.vote_average * 100) : 0,
                        runtime: episodeData.runtime || 0,
                        url: episodeData.link || `${movieKey}|s${seasonNumber}e${parseInt(episodeKey) + 1}`
                    });
                });
            });

            // Fallback episodes if WebSocket fails
            if (episodes.length === 0) {
                console.log('WebSocket failed, using fallback episodes');
                for (let season = 1; season <= 2; season++) {
                    for (let episode = 1; episode <= 6; episode++) {
                        episodes.push({
                            name: `Episode ${episode}`,
                            season: season,
                            episode: episode,
                            description: `Episode ${episode} of Season ${season}`,
                            url: `${movieKey}|s${season}e${episode}`
                        });
                    }
                }
            }

            contentData.episodes = episodes;
            contentData.seasonCount = seasonCount;
        } else {
            contentData.dataUrl = item.movielink || '';
        }

        res.json({
            success: true,
            data: contentData
        });

    } catch (error) {
        console.error('Error in /api/content:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to load content',
            message: error.message
        });
    }
});

// Get streaming links
app.get('/api/links/:id', async (req, res) => {
    try {
        const data = req.params.id;
        
        if (data.startsWith("error|")) {
            return res.json({
                success: false,
                error: 'Cannot load links for error item'
            });
        }

        const config = await getConfig();
        const links = [];

        if (data.startsWith("tv/") && data.includes("/s") && data.endsWith(".mkv")) {
            // Real TV Show episode link from WebSocket
            config.premium.forEach(baseUrl => {
                const videoUrl = baseUrl + data;
                links.push({
                    source: 'StreamFlix',
                    name: 'StreamFlix - Premium',
                    url: videoUrl,
                    type: 'video',
                    quality: 720,
                    headers: { "Referer": MAIN_URL }
                });
            });

            config.tv.forEach(baseUrl => {
                const videoUrl = baseUrl + data;
                links.push({
                    source: 'StreamFlix',
                    name: 'StreamFlix - TV',
                    url: videoUrl,
                    type: 'video',
                    quality: 480,
                    headers: { "Referer": MAIN_URL }
                });
            });

        } else if (data.includes("|s") && data.includes("e")) {
            // Fallback TV Show episode format
            const [movieKey, episodeInfo] = data.split("|");
            const seasonMatch = episodeInfo.match(/s(\\d+)/);
            const episodeMatch = episodeInfo.match(/e(\\d+)/);

            if (seasonMatch && episodeMatch) {
                const season = seasonMatch[1];
                const episode = episodeMatch[1];

                config.premium.forEach(baseUrl => {
                    const videoUrl = `${baseUrl}tv/${movieKey}/s${season}/episode${episode}.mkv`;
                    links.push({
                        source: 'StreamFlix',
                        name: 'StreamFlix - Premium',
                        url: videoUrl,
                        type: 'video',
                        quality: 720,
                        headers: { "Referer": MAIN_URL }
                    });
                });
            }
        } else {
            // Movie
            const movieLink = data;
            if (movieLink) {
                config.premium.forEach(baseUrl => {
                    const videoUrl = baseUrl + movieLink;
                    links.push({
                        source: 'StreamFlix',
                        name: 'StreamFlix - Premium',
                        url: videoUrl,
                        type: 'video',
                        quality: 720,
                        headers: { "Referer": MAIN_URL }
                    });
                });

                config.movies.forEach(baseUrl => {
                    const videoUrl = baseUrl + movieLink;
                    links.push({
                        source: 'StreamFlix',
                        name: 'StreamFlix - Movies',
                        url: videoUrl,
                        type: 'video',
                        quality: 480,
                        headers: { "Referer": MAIN_URL }
                    });
                });
            }
        }

        res.json({
            success: true,
            data: {
                links: links,
                total: links.length
            }
        });

    } catch (error) {
        console.error('Error in /api/links:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to load links',
            message: error.message
        });
    }
});

// Get configuration
app.get('/api/config', async (req, res) => {
    try {
        const config = await getConfig();
        res.json({
            success: true,
            data: config
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to get configuration',
            message: error.message
        });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'StreamFlix API is running',
        timestamp: new Date().toISOString()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'StreamFlix API',
        version: '2.0',
        endpoints: {
            home: '/api/home?page=1&limit=20',
            search: '/api/search?q=query&page=1&limit=20',
            content: '/api/content/:id',
            links: '/api/links/:id',
            config: '/api/config',
            health: '/api/health'
        }
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`StreamFlix API running on port ${PORT}`);
});

module.exports = app;