import { GoogleGenAI, Modality } from "@google/genai";

// --- Type Definitions ---
declare global {
    // FIX: Replaced inline type with a named interface `AIStudio` for `window.aistudio`
    // to resolve "All declarations of 'aistudio' must have identical modifiers" and
    // "Subsequent property declarations must have the same type" errors.
    // This aligns this declaration with an existing one elsewhere.
    interface AIStudio {
        hasSelectedApiKey: () => Promise<boolean>;
        openSelectKey: () => Promise<void>;
    }
    interface Window {
        aistudio: AIStudio;
    }
}

type Message = {
    role: 'user' | 'model';
    text: string;
    // model-specific data
    image?: string;
    video?: string;
    sources?: any[];
    code?: { html: string; css: string; javascript: string; };
};

type Chat = {
    id: number;
    title: string;
    history: Message[];
};

type AppState = {
    isAuthenticated: boolean;
    chats: Chat[];
    activeChatId: number | null;
    nextChatId: number;
};

// --- DOM Element Refs ---
let authButton: HTMLButtonElement;
let tabsContainer: HTMLDivElement;
let appContainer: HTMLDivElement;
let mainContent: HTMLElement;
let chatContainer: HTMLDivElement;
let searchFormContainer: HTMLDivElement;
let searchForm: HTMLFormElement;
let searchInput: HTMLInputElement;
let searchButton: HTMLButtonElement;
let artifactContainer: HTMLElement;
let artifactFrame: HTMLIFrameElement;
let closeArtifactButton: HTMLButtonElement;


// --- State Management ---
let ai: GoogleGenAI;
let isLoading = false;
let state: AppState = {
    isAuthenticated: false,
    chats: [],
    activeChatId: null,
    nextChatId: 1,
};
let activeArtifactMessageIndex: number | null = null;

// --- Helper Functions ---
function escapeHtml(unsafe: string): string {
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function simpleMarkdownToHtml(markdown: string): string {
    let html = markdown;
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => `<pre><code class="language-${lang}">${escapeHtml(code.trim())}</code></pre>`);
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    const parts = html.split(/(<pre>[\s\S]*?<\/pre>)/);
    let finalHtml = '';
    for (const part of parts) {
        if (part.startsWith('<pre>')) {
            finalHtml += part;
            continue;
        }
        let inList = false;
        let sectionHtml = '';
        const lines = part.split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
            if (line.trim().startsWith('* ')) {
                if (!inList) {
                    sectionHtml += '<ul>';
                    inList = true;
                }
                sectionHtml += `<li>${line.trim().substring(2)}</li>`;
            } else {
                if (inList) {
                    sectionHtml += '</ul>';
                    inList = false;
                }
                sectionHtml += `<p>${line}</p>`;
            }
        }
        if (inList) sectionHtml += '</ul>';
        finalHtml += sectionHtml;
    }
    return finalHtml;
}

function extractCode(markdown: string) {
    const extracted = { html: '', css: '', javascript: '' };
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let match;
    let hasCode = false;
    while ((match = codeBlockRegex.exec(markdown)) !== null) {
        const lang = match[1].toLowerCase();
        const code = match[2].trim();
        if (lang === 'html') { extracted.html += code + '\n'; hasCode = true; }
        else if (lang === 'css') { extracted.css += code + '\n'; hasCode = true; }
        else if (lang === 'javascript' || lang === 'js') { extracted.javascript += code + '\n'; hasCode = true; }
    }
    return hasCode ? extracted : null;
}

// --- State Persistence ---
function saveState() {
    localStorage.setItem('slimeeState', JSON.stringify(state));
}

function loadState() {
    const savedState = localStorage.getItem('slimeeState');
    if (savedState) {
        state = JSON.parse(savedState);
    }
}

// --- Main Application Logic ---
async function handleSearch(event: Event) {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (!query || isLoading || !state.activeChatId) return;

    isLoading = true;
    updateUIForLoading();

    const activeChat = state.chats.find(c => c.id === state.activeChatId)!;
    activeChat.history.push({ role: 'user', text: query });
    saveState();
    renderChatHistory(); // Show user message immediately
    searchInput.value = '';

    const modelMessage: Message = { role: 'model', text: '' };
    activeChat.history.push(modelMessage);
    const modelMessageBubble = createModelMessageBubble(modelMessage, true, activeChat.history.length - 1);
    chatContainer.appendChild(modelMessageBubble);
    mainContent.scrollTop = mainContent.scrollHeight;
    
    const imageKeywords = /^(draw|create|generate|make an image of|show me a picture of)/i;
    const videoKeywords = /\b(video of|animate|generate a video|create a video)\b/i;
    const codeKeywords = /\b(code|write|html|css|javascript|js|function|snippet|app|component)\b/i;

    try {
        if (imageKeywords.test(query)) {
            await handleImageGeneration(query, modelMessage, modelMessageBubble);
        } else if (videoKeywords.test(query)) {
            await handleVideoGeneration(query, modelMessage, modelMessageBubble);
        } else if (codeKeywords.test(query)) {
            await handleCodeGeneration(query, modelMessage, modelMessageBubble);
        } else {
            await handleTextSearch(query, modelMessage, modelMessageBubble);
        }
    } catch (error) {
        console.error("Search failed:", error);
        modelMessage.text = 'Sorry, an error occurred. Please try again.';
    } finally {
        isLoading = false;
        updateUIForLoading();
        renderChatHistory(); // Re-render the final state
        saveState();
    }
}

async function handleImageGeneration(query: string, message: Message, bubble: HTMLElement) {
    const answerDiv = bubble.querySelector('.answer-content') as HTMLDivElement;
    answerDiv.innerHTML = '<p>Generating your image...</p>';
    
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: query }] },
        config: { responseModalities: [Modality.IMAGE] },
    });

    let base64ImageBytes = '';
    for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
            base64ImageBytes = part.inlineData.data;
            break;
        }
    }

    if (base64ImageBytes) {
        message.image = `data:image/png;base64,${base64ImageBytes}`;
        message.text = `Here is the image you requested for: "${query}"`;
    } else {
        message.text = "Sorry, I couldn't create that image.";
    }
}

async function handleVideoGeneration(query: string, message: Message, bubble: HTMLElement, isRetry = false) {
    const answerDiv = bubble.querySelector('.answer-content') as HTMLDivElement;
    try {
        if (!isRetry) {
            let hasKey = await window.aistudio.hasSelectedApiKey();
            if (!hasKey) {
                answerDiv.innerHTML = `<p>To generate videos, you need to select a Gemini API key with billing enabled. Opening the key selection dialog now...</p><a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" style="color: var(--primary-color);">Learn more</a>`;
                await new Promise(resolve => setTimeout(resolve, 2500));
                await window.aistudio.openSelectKey();
            }
        }
        const localAi = new GoogleGenAI({ apiKey: process.env.API_KEY });
        answerDiv.innerHTML = '<p id="videoStatus">Kicking off video generation... this may take a few minutes.</p>';
        
        let operation = await localAi.models.generateVideos({ model: 'veo-3.1-fast-generate-preview', prompt: query, config: { numberOfVideos: 1, resolution: '720p', aspectRatio: '16:9' } });
        const videoStatusEl = answerDiv.querySelector('#videoStatus');
        while (!operation.done) {
            if (videoStatusEl) videoStatusEl.textContent = 'Video is processing... please wait.';
            await new Promise(resolve => setTimeout(resolve, 10000));
            operation = await localAi.operations.getVideosOperation({ operation: operation });
        }
        if (videoStatusEl) videoStatusEl.textContent = 'Almost there! Fetching your video...';
        
        const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
        if (!downloadLink) throw new Error("No download link provided.");

        const videoResponse = await fetch(`${downloadLink}&key=${process.env.API_KEY}`);
        if (!videoResponse.ok) throw new Error(`Failed to download video: ${videoResponse.statusText}`);
        
        const videoBlob = await videoResponse.blob();
        message.video = URL.createObjectURL(videoBlob);
        message.text = `Here is the video you requested.`;

    } catch (error: any) {
        if (error.message?.includes('Requested entity was not found')) {
            if (isRetry) {
                message.text = 'Video generation failed again. Please ensure your selected key is valid and has billing enabled.'; return;
            }
            answerDiv.innerHTML = `<p>Video generation failed due to an API key issue. Reopening key selection for a retry...</p>`;
            await new Promise(resolve => setTimeout(resolve, 3000));
            await window.aistudio.openSelectKey();
            await handleVideoGeneration(query, message, bubble, true);
        } else {
            console.error('Video generation error:', error);
            message.text = 'Sorry, I couldn\'t create that video.';
        }
    }
}

async function handleCodeGeneration(query: string, message: Message, bubble: HTMLElement) {
    const answerDiv = bubble.querySelector('.answer-content') as HTMLDivElement;
    const stream = await ai.models.generateContentStream({ model: "gemini-2.5-pro", contents: query, config: { systemInstruction: "You are a coding assistant. Provide complete, runnable code for a single HTML file, including CSS in a <style> tag and JavaScript in a <script> tag. Use markdown fences with the language specified." } });
    
    let fullText = '';
    for await (const chunk of stream) {
        const chunkText = chunk.text;
        if (chunkText) {
            fullText += chunkText;
            answerDiv.innerHTML = simpleMarkdownToHtml(fullText);
            mainContent.scrollTop = mainContent.scrollHeight;
        }
    }
    message.text = fullText;
    message.code = extractCode(fullText) ?? undefined;
}

async function handleTextSearch(query: string, message: Message, bubble: HTMLElement) {
    const answerDiv = bubble.querySelector('.answer-content') as HTMLDivElement;
    const stream = await ai.models.generateContentStream({ model: "gemini-2.5-flash", contents: query, config: { tools: [{ googleSearch: {} }] } });
    
    let fullText = '';
    for await (const chunk of stream) {
        const chunkText = chunk.text;
        if (chunkText) {
            fullText += chunkText;
            answerDiv.innerHTML = simpleMarkdownToHtml(fullText);
            mainContent.scrollTop = mainContent.scrollHeight;
        }
        const groundingMetadata = chunk.candidates?.[0]?.groundingMetadata;
        if (groundingMetadata?.groundingChunks?.length > 0) {
            message.sources = groundingMetadata.groundingChunks;
        }
    }
    message.text = fullText;
}


// --- UI Rendering ---

function renderApp() {
    if (state.isAuthenticated) {
        authButton.textContent = 'Sign Out';
        tabsContainer.classList.remove('hidden');
        searchFormContainer.classList.remove('hidden');
        renderTabs();
        renderChatHistory();
        renderArtifactPane();
    } else {
        authButton.textContent = 'Sign In';
        tabsContainer.classList.add('hidden');
        searchFormContainer.classList.add('hidden');
        appContainer.classList.add('hidden');
        chatContainer.innerHTML = `
            <div id="welcomeScreen">
              <h1>Welcome to SlimeE</h1>
              <p>Sign in to start a new conversation.</p>
            </div>
        `;
        // Ensure main content is visible for welcome screen
        mainContent.style.display = 'flex';
        appContainer.classList.remove('hidden');
    }
}

function renderTabs() {
    tabsContainer.innerHTML = '';
    state.chats.forEach(chat => {
        const tab = document.createElement('div');
        tab.className = 'tab-item';
        tab.textContent = chat.title;
        tab.dataset.chatId = chat.id.toString();
        if (chat.id === state.activeChatId) {
            tab.classList.add('active');
        }
        tab.addEventListener('click', () => handleTabSwitch(chat.id));
        tabsContainer.appendChild(tab);
    });

    const newChatBtn = document.createElement('button');
    newChatBtn.id = 'newChatButton';
    newChatBtn.textContent = '+';
    newChatBtn.addEventListener('click', handleNewChat);
    tabsContainer.appendChild(newChatBtn);
}

function renderChatHistory() {
    chatContainer.innerHTML = '';
    const activeChat = state.chats.find(c => c.id === state.activeChatId);
    if (!activeChat || activeChat.history.length === 0) {
        chatContainer.innerHTML = `
            <div id="welcomeScreen">
              <h1>SlimeE</h1>
              <p>Ask anything, from web searches to code and images.</p>
            </div>
        `;
        return;
    }
    activeChat.history.forEach((message, index) => {
        const bubble = message.role === 'user' ? createUserMessageBubble(message) : createModelMessageBubble(message, false, index);
        if (index === activeArtifactMessageIndex) {
            bubble.classList.add('active-artifact');
        }
        chatContainer.appendChild(bubble);
    });
    mainContent.scrollTop = mainContent.scrollHeight;
}

function createUserMessageBubble(message: Message): HTMLElement {
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble user-message';
    bubble.textContent = message.text;
    return bubble;
}

function createModelMessageBubble(message: Message, showLoader: boolean, index: number): HTMLElement {
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble model-message';
    
    let contentHTML = '';
    if (showLoader) {
        contentHTML = `<div class="loader-container"><div class="loader"></div></div>`;
    }
    
    contentHTML += `<div class="answer-content">${simpleMarkdownToHtml(message.text)}</div>`;
    
    if (message.image) {
        contentHTML += `<img src="${message.image}" alt="Generated image" class="result-media">`;
    }
    if (message.video) {
        contentHTML += `<video src="${message.video}" controls class="result-media"></video>`;
    }
    if (message.sources && message.sources.length > 0) {
        const sourcesLinks = message.sources.map(chunk => {
            if (chunk.web) {
                return `<a href="${chunk.web.uri}" target="_blank" class="source-link">
                    <span class="title">${chunk.web.title || 'Untitled'}</span>
                    <span class="uri">${chunk.web.uri}</span>
                </a>`;
            }
            return '';
        }).join('');
        contentHTML += `<div class="sources-container"><h3 class="sources-header">Sources</h3><div class="sources-list">${sourcesLinks}</div></div>`;
    }

    bubble.innerHTML = contentHTML;

    if (message.code) {
        const viewArtifactButton = document.createElement('button');
        viewArtifactButton.className = 'view-artifact-button';
        viewArtifactButton.textContent = 'View Artifact';
        viewArtifactButton.addEventListener('click', (e) => {
            e.stopPropagation();
            handleArtifactView(index);
        });
        bubble.appendChild(viewArtifactButton);
    }

    return bubble;
}

function renderArtifactPane() {
    const activeChat = state.chats.find(c => c.id === state.activeChatId);
    if (activeChat && activeArtifactMessageIndex !== null) {
        const message = activeChat.history[activeArtifactMessageIndex];
        if (message && message.code) {
            artifactFrame.srcdoc = `<html><head><style>${message.code.css}</style></head><body>${message.code.html}<script>${message.code.javascript}</script></body></html>`;
            artifactContainer.classList.remove('hidden');
            appContainer.classList.add('artifact-visible');
            return;
        }
    }
    // Hide pane if no active artifact
    artifactContainer.classList.add('hidden');
    appContainer.classList.remove('artifact-visible');
}


function updateUIForLoading() {
    searchButton.disabled = isLoading;
    searchInput.disabled = isLoading;
}

// --- Event Handlers ---
function handleAuthClick() {
    if (state.isAuthenticated) { // Sign Out
        state = { isAuthenticated: false, chats: [], activeChatId: null, nextChatId: 1 };
        closeArtifactPane();
    } else { // Sign In
        state.isAuthenticated = true;
        if (state.chats.length === 0) {
            handleNewChat(); // Create the first chat
        }
    }
    saveState();
    renderApp();
}

function handleTabSwitch(chatId: number) {
    if (chatId === state.activeChatId) return;
    state.activeChatId = chatId;
    closeArtifactPane(); // also saves state and re-renders
}

function handleNewChat() {
    const newChat: Chat = {
        id: state.nextChatId,
        title: `Chat ${state.nextChatId}`,
        history: [],
    };
    state.nextChatId++;
    state.chats.push(newChat);
    state.activeChatId = newChat.id;
    closeArtifactPane(); // also saves state and re-renders
    searchInput.focus();
}

function handleArtifactView(index: number) {
    activeArtifactMessageIndex = index;
    renderChatHistory();
    renderArtifactPane();
}

function closeArtifactPane() {
    activeArtifactMessageIndex = null;
    saveState();
    renderTabs();
    renderChatHistory();
    renderArtifactPane();
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    if (!process.env.API_KEY) {
        document.body.innerHTML = `<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; text-align: center; padding: 1rem;"><h1>Configuration Error</h1><p>The Gemini API key is missing. Please ensure the <code>API_KEY</code> environment variable is set.</p></div>`;
        return;
    }

    ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    authButton = document.getElementById('authButton') as HTMLButtonElement;
    tabsContainer = document.getElementById('tabsContainer') as HTMLDivElement;
    appContainer = document.getElementById('appContainer') as HTMLDivElement;
    mainContent = document.getElementById('mainContent') as HTMLElement;
    chatContainer = document.getElementById('chatContainer') as HTMLDivElement;
    searchFormContainer = document.getElementById('searchFormContainer') as HTMLDivElement;
    searchForm = document.getElementById('searchForm') as HTMLFormElement;
    searchInput = document.getElementById('searchInput') as HTMLInputElement;
    searchButton = document.getElementById('searchButton') as HTMLButtonElement;
    artifactContainer = document.getElementById('artifactContainer') as HTMLElement;
    artifactFrame = document.getElementById('artifactFrame') as HTMLIFrameElement;
    closeArtifactButton = document.getElementById('closeArtifactButton') as HTMLButtonElement;


    authButton.addEventListener('click', handleAuthClick);
    searchForm.addEventListener('submit', handleSearch);
    closeArtifactButton.addEventListener('click', closeArtifactPane);

    loadState();
    renderApp();
});