import { extension_settings, getContext } from "../../../extensions.js";
import { chat, chat_metadata, event_types, eventSource, main_api, saveSettingsDebounced } from '../../../../script.js';
import { metadata_keys } from '../../../authors-note.js';
import { promptManager } from '../../../openai.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { delay } from '../../../utils.js';
import { world_info_position } from '../../../world-info.js';

const extensionName = "st-info-block-merged";

let lastPromptData = null;
let currentEntryList = [];
let generationType;

let panel;
let wiContainer;

const strategy = { constant: '🔵', normal: '🟢', vectorized: '🔗' };
const getStrategy = (entry) => {
    if (entry.constant === true) return 'constant';
    if (entry.vectorized === true) return 'vectorized';
    return 'normal';
};

function countContext(showToast = false) {
    const context = getContext();
    if (!chat || !Array.isArray(chat)) return;

    const totalMessages = chat.length;
    const hiddenMessages = chat.filter(m => m.is_system === true);
    const visibleMessages = chat.filter(m => m.is_system !== true);

    let visibleTokens = 0;
    let hiddenTokens = 0;

    if (context && typeof context.getTokenCount === 'function') {
        for (const m of visibleMessages) visibleTokens += context.getTokenCount(m.mes || "");
        for (const m of hiddenMessages) hiddenTokens += context.getTokenCount(m.mes || "");
    }

    let totalPromptTokens = 0;
    let systemTokens = 0;

    if (lastPromptData && lastPromptData.prompt) {
        for (const item of lastPromptData.prompt) {
            const text = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
            if (context && typeof context.getTokenCount === 'function') {
                const t = context.getTokenCount(text);
                totalPromptTokens += t;
                if (item.role === "system") systemTokens += t;
            }
        }
    }

    $(panel).find("#cm_total_messages").text(totalMessages);
    $(panel).find("#cm_visible_messages").text(visibleMessages.length);
    $(panel).find("#cm_hidden_messages").text(hiddenMessages.length);
    $(panel).find("#cm_chat_tokens_visible").text(visibleTokens.toLocaleString());
    $(panel).find("#cm_chat_tokens_hidden").text(hiddenTokens.toLocaleString());

    if (lastPromptData) {
        $(panel).find("#cm_prompt_total").text(totalPromptTokens.toLocaleString());
        $(panel).find("#cm_prompt_system").text(systemTokens.toLocaleString());
        $(panel).find("#cm_prompt_chat").text((totalPromptTokens - systemTokens).toLocaleString());
        $(panel).find("#cm_no_prompt_warning").hide();
        $(panel).find("#cm_prompt_stats").show();
    } else {
        $(panel).find("#cm_no_prompt_warning").show();
        $(panel).find("#cm_prompt_stats").hide();
    }
    
    if (showToast) toastr.success("Context counted!", "Info Block");
}

const init = () => {
    panel = document.createElement('div');
    panel.classList.add('stwii--panel');
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="stwii--quick-actions"></div>
        <div class="stwii--stats-container">
            <div class="cm-stats">
                <div style="margin-bottom: 10px; text-align: center;">
                    <input id="cm_count_btn" class="menu_button" type="submit" value="🔍 Count Context" style="width: 100%; cursor: pointer;">
                </div>
                <div class="cm-section-title">💬 Messages</div>
                <div class="cm-row"><span>Total:</span> <b id="cm_total_messages">—</b></div>
                <div class="cm-row"><span>Visible:</span> <b id="cm_visible_messages">—</b></div>
                <div class="cm-row cm-muted"><span>Hidden (/hide):</span> <b id="cm_hidden_messages">—</b></div>
                <div class="cm-section-title" style="margin-top: 8px;">💬 Chat tokens</div>
                <div class="cm-row"><span>Visible messages:</span> <b id="cm_chat_tokens_visible">—</b></div>
                <div class="cm-row cm-muted"><span>Hidden messages:</span> <b id="cm_chat_tokens_hidden">—</b></div>
                <div class="cm-section-title" style="margin-top: 8px;">📤 Last sent prompt</div>
                <div id="cm_no_prompt_warning" class="cm-warning">⚠️ Make a generation first</div>
                <div id="cm_prompt_stats" style="display:none;">
                    <div class="cm-row cm-total"><span>Total (prompt_tokens):</span> <b id="cm_prompt_total">—</b></div>
                </div>
                <div class="stwii--settings-row">
                    <input type="checkbox" id="stwii--toggle-native-btns">
                    <label for="stwii--toggle-native-btns" style="cursor: pointer;">Hide native message actions</label>
                </div>
            </div>
        </div>
        <div class="stwii--wi-container">Waiting for World Info...</div>
    `;
    document.body.append(panel);
    wiContainer = panel.querySelector('.stwii--wi-container');

    const btnToggle = $(panel).find('#stwii--toggle-native-btns');
    const isHiddenSaved = localStorage.getItem('stwii_hide_native') === 'true';
    btnToggle.prop('checked', isHiddenSaved);
    if (isHiddenSaved) $('body').addClass('stwii--hide-native');

    btnToggle.on('change', function() {
        const isChecked = $(this).is(':checked');
        localStorage.setItem('stwii_hide_native', isChecked);
        if (isChecked) $('body').addClass('stwii--hide-native');
        else $('body').removeClass('stwii--hide-native');
    });

    const injectButtonsToMessages = () => {
        $('.mes_buttons').each(function() {
            if ($(this).find('.stwii--trigger-btn').length === 0) {
                $(this).prepend('<div class="mes_button interactable fa-solid fa-dragon stwii--trigger-btn" title="Info & Context"></div>');
            }
        });
    };

    eventSource.on(event_types.MESSAGE_RENDERED, injectButtonsToMessages);
    eventSource.on(event_types.CHAT_CHANGED, injectButtonsToMessages);
    setTimeout(injectButtonsToMessages, 1000);

    $(document).on('click', '.stwii--trigger-btn', function(e) {
        e.preventDefault();
        const messageBlock = $(this).closest('.mes');
        const mesId = parseInt(messageBlock.attr('mesid'));

        const actionContainer = $(panel).find('.stwii--quick-actions');
        actionContainer.empty();

        // --- ФИЧА 1: Скрытие сообщений ---
        const isHidden = chat[mesId]?.is_system;
        const hideSingleBtn = $(`<div class="stwii--proxy-btn" title="Toggle Visibility (This message)">
            <i class="fa-solid ${isHidden ? 'fa-eye' : 'fa-eye-slash'}"></i>
        </div>`);
        
        const hideMassBtn = $(`<div class="stwii--proxy-btn" title="Mass Toggle Visibility (Range 0-X)">
            <i class="fa-solid fa-layer-group"></i>
        </div>`);
        
        const toggleMessages = async (range, forceState = null) => {
            const firstId = parseInt(range.split('-')[0]);
            const targetState = forceState !== null ? forceState : !chat[firstId]?.is_system;
            const commandName = targetState ? 'hide' : 'unhide';
            
            if (SlashCommandParser.commands[commandName]) {
                await SlashCommandParser.commands[commandName].callback({}, range);
                countContext(false);
            }
        };

        hideSingleBtn.on('click', async function(evt) {
            evt.stopPropagation();
            await toggleMessages(`${mesId}`);
            const newState = chat[mesId]?.is_system;
            $(this).find('i').removeClass('fa-eye fa-eye-slash').addClass(newState ? 'fa-eye' : 'fa-eye-slash');
        });

        hideMassBtn.on('click', async function(evt) {
            evt.stopPropagation();
            const rangeStr = window.prompt('Введите диапазон (например, 0-35) или одно число:', `${mesId}-${mesId + 5}`);
            if (!rangeStr) return;
            
            // ИСПРАВЛЕНА РЕГУЛЯРКА: теперь она корректно проверяет формат цифра-цифра
            const isValid = /^\s*\d+\s*(-\s*\d+\s*)?$/.test(rangeStr);
            
            if (isValid) {
                // Очищаем от случайных пробелов
                const cleanRange = rangeStr.replace(/\s+/g, '');
                const firstId = parseInt(cleanRange.split('-')[0]);
                const currentState = chat[firstId]?.is_system;
                const confirmMsg = currentState ? `Раскрыть сообщения: ${cleanRange}?` : `Скрыть сообщения: ${cleanRange}?`;
                
                if (window.confirm(confirmMsg)) {
                    await toggleMessages(cleanRange, !currentState);
                    const newState = chat[mesId]?.is_system;
                    hideSingleBtn.find('i').removeClass('fa-eye fa-eye-slash').addClass(newState ? 'fa-eye' : 'fa-eye-slash');
                }
            } else {
                toastr.error("Неверный формат. Используйте 'X-Y' или 'X'.");
            }
        });

        actionContainer.append(hideSingleBtn);
        actionContainer.append(hideMassBtn);

        // --- ФИЧА 2: ВЫПОТРАШИВАЕМ ВСЕ КНОПКИ ТАВЕРНЫ (ИГНОРИРУЕМ ТРИ ТОЧКИ И РАССУЖДЕНИЯ) ---
        // Исключаем: нашу кнопку Дракона, кнопку трех точек, кнопку закрытия редактора 
        // И ВСЕ кнопки, которые лежат внутри блока рассуждений (.mes_reasoning_actions)
        const allActionButtons = messageBlock.find('.mes_button')
            .not('.stwii--trigger-btn, .mes_edit_btn, .mes_edit_buttons_close, .mes_reasoning_actions .mes_button');
        
        allActionButtons.each(function() {
            const btn = $(this);
            const proxyBtn = btn.clone().removeClass('mes_button interactable').addClass('stwii--proxy-btn');
            proxyBtn.off(); 
            
            proxyBtn.on('click', function(evt) {
                evt.stopPropagation();
                btn.trigger('click'); 
                
                if (btn.hasClass('mes_edit') || btn.hasClass('mes_delete') || btn.hasClass('swipe_left') || btn.hasClass('swipe_right')) {
                    panel.style.display = 'none';
                }
            });
            actionContainer.append(proxyBtn);
        });

        countContext(false);
        
        // Позиционирование окна
        if (panel.style.display === 'none' || panel.style.display === '') {
            panel.style.visibility = 'hidden';
            panel.style.display = 'flex';
            const rect = this.getBoundingClientRect();
            const panelHeight = panel.offsetHeight || 300; 
            let topPos = rect.bottom + 10; 
            let leftPos = rect.left - 250; 
            if (leftPos < 10) leftPos = 10;
            if (topPos + panelHeight > window.innerHeight) {
                topPos = rect.top - panelHeight - 10;
                if (topPos < 10) topPos = 10; 
            }
            panel.style.top = `${topPos}px`;
            panel.style.left = `${leftPos}px`;
            panel.style.maxHeight = `${window.innerHeight - 20}px`; 
            panel.style.visibility = 'visible';
        } else {
            panel.style.display = 'none';
        }
    });

    $(document).on('click', '#cm_count_btn', function(e) {
        e.preventDefault(); e.stopPropagation();
        const btn = $(this); const originalVal = btn.val(); btn.val('Calculating...');
        try { countContext(true); setTimeout(() => btn.val(originalVal), 500); } catch(err) {}
    });

    eventSource.on(event_types.GENERATION_STARTED, (genType) => generationType = genType);
    const context = getContext();
    eventSource.on(context.event_types.GENERATE_AFTER_DATA ?? "generate_after_data", (data) => lastPromptData = data);

    eventSource.on(event_types.WORLD_INFO_ACTIVATED, async (entryList) => {
        wiContainer.innerHTML = 'Updating...';
        for (const entry of entryList) {
            entry.type = 'wi';
            entry.sticky = parseInt(await SlashCommandParser.commands['wi-get-timed-effect'].callback({ effect: 'sticky', format: 'number', file: `${entry.world}`, _scope: null, _abortController: null }, entry.uid));
        }
        currentEntryList = [...entryList];
        updatePanel(entryList, true);
    });

    const updatePanel = (entryList, newChat = false) => {
        wiContainer.innerHTML = ''; 
        const context = getContext();
        const grouped = Object.groupBy(entryList, (it) => it.world);
        for (const [world, entries] of Object.entries(grouped)) {
            const w = document.createElement('div');
            w.classList.add('stwii--world');
            w.textContent = world;
            wiContainer.append(w);
            for (const entry of entries) {
                const e = document.createElement('div');
                e.classList.add('stwii--entry');
                const strat = document.createElement('div');
                strat.textContent = strategy[getStrategy(entry)];
                e.append(strat);
                const title = document.createElement('div');
                title.textContent = entry.comment?.length ? entry.comment : entry.key.join(', ');
                e.title = `[${entry.world}] ${title.textContent}\n---\n${entry.content}`;
                e.append(title);
                if (context && typeof context.getTokenCount === 'function') {
                    const tokensBadge = document.createElement('div');
                    tokensBadge.textContent = `${context.getTokenCount(entry.content || "")}t`;
                    tokensBadge.classList.add('stwii--token-badge');
                    e.append(tokensBadge);
                }
                wiContainer.append(e);
            }
        }
    };

    // --- ФИЧА 3: ИНТЕГРАЦИЯ В ВОЛШЕБНУЮ ПАЛОЧКУ ---
    const addMagicWandButton = () => {
        const wandMenu = $('#extensionsMenu');
        // Проверяем, что меню существует и нашей кнопки там еще нет
        if (wandMenu.length && $('#stwii_wand_container').length === 0) {
            // Создаем структуру точно как в Таверне
            const wandContainer = $(`<div id="stwii_wand_container" class="extension_container interactable" tabindex="0">
                <div class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem">
                    <i class="fa-solid fa-layer-group"></i> <span>ST Info Blocks</span>
                </div>
            </div>`);

            wandContainer.on('click', function(e) {
                e.stopPropagation();
                
                // 1. Скрываем саму выпадающую менюшку палочки
                $('#extensionsMenu').hide(); 
                
                // 2. Очищаем кнопки действий (мы ведь не выбрали сообщение)
                $(panel).find('.stwii--quick-actions').empty();
                
                // 3. Обновляем счетчики контекста
                countContext(false);
                
                // 4. Показываем панель ровно по центру экрана
                panel.style.visibility = 'hidden';
                panel.style.display = 'flex';
                
                const pWidth = panel.offsetWidth || 320;
                const pHeight = panel.offsetHeight || 400;
                
                panel.style.top = `${Math.max(10, (window.innerHeight - pHeight) / 2)}px`;
                panel.style.left = `${Math.max(10, (window.innerWidth - pWidth) / 2)}px`;
                panel.style.maxHeight = `${window.innerHeight - 20}px`; 
                
                panel.style.visibility = 'visible';
            });

            // Добавляем в конец меню расширений
            wandMenu.append(wandContainer);
        }
    };

    // Пытаемся добавить кнопку сразу, а также через 2 секунды 
    // (на случай, если Таверна рендерит волшебную палочку с задержкой)
    addMagicWandButton();
    setTimeout(addMagicWandButton, 2000);

    // --- ОБНОВЛЕННОЕ ЗАКРЫТИЕ ОКНА ---
    $(document).on('click', function(e) {
        const isPanel = $(e.target).closest('.stwii--panel').length;
        const isTrigger = $(e.target).closest('.stwii--trigger-btn').length;
        const isWand = $(e.target).closest('#stwii_wand_container').length; // Добавили палочку в исключения
        
        if (!isPanel && !isTrigger && !isWand) {
            if (panel.style.display === 'flex') panel.style.display = 'none';
        }
    });

    console.log(`[${extensionName}] ✅ Loaded successfully`);
};

jQuery(async () => { init(); });