import { power_user } from './power-user.js';
import { delay } from './utils.js';

/**
 * A stream which handles Server-Sent Events from a binary ReadableStream like you get from the fetch API.
 */
class EventSourceStream {
    constructor() {
        const decoder = new TextDecoderStream('utf-8');

        let streamBuffer = '';
        let lastEventId = '';

        function processChunk(controller) {
            // Events are separated by two newlines
            const events = streamBuffer.split(/\r\n\r\n|\r\r|\n\n/g);
            if (events.length === 0) return;

            // The leftover text to remain in the buffer is whatever doesn't have two newlines after it. If the buffer ended
            // with two newlines, this will be an empty string.
            streamBuffer = events.pop();

            for (const eventChunk of events) {
                let eventType = '';
                // Split up by single newlines.
                const lines = eventChunk.split(/\n|\r|\r\n/g);
                let eventData = '';
                for (const line of lines) {
                    const lineMatch = /([^:]+)(?:: ?(.*))?/.exec(line);
                    if (lineMatch) {
                        const field = lineMatch[1];
                        const value = lineMatch[2] || '';

                        switch (field) {
                            case 'event':
                                eventType = value;
                                break;
                            case 'data':
                                eventData += value;
                                eventData += '\n';
                                break;
                            case 'id':
                                // The ID field cannot contain null, per the spec
                                if (!value.includes('\0')) lastEventId = value;
                                break;
                            // We do nothing for the `delay` type, and other types are explicitly ignored
                        }
                    }
                }


                // https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage
                // Skip the event if the data buffer is the empty string.
                if (eventData === '') continue;

                if (eventData[eventData.length - 1] === '\n') {
                    eventData = eventData.slice(0, -1);
                }

                // Trim the *last* trailing newline only.
                const event = new MessageEvent(eventType || 'message', { data: eventData, lastEventId });
                controller.enqueue(event);
            }
        }

        const sseStream = new TransformStream({
            transform(chunk, controller) {
                streamBuffer += chunk;
                processChunk(controller);
            },
        });

        decoder.readable.pipeThrough(sseStream);

        this.readable = sseStream.readable;
        this.writable = decoder.writable;
    }
}

/**
 * Gets a delay based on the character.
 * @param {string} s The character.
 * @returns {number} The delay in milliseconds.
 */
function getDelay(s) {
    if (!s) {
        return 0;
    }

    const speedFactor = Math.max(100 - power_user.smooth_streaming_speed, 1);
    const defaultDelayMs = speedFactor * 0.4;
    const punctuationDelayMs = defaultDelayMs * 25;

    if ([',', '\n'].includes(s)) {
        return punctuationDelayMs / 2;
    }

    if (['.', '!', '?'].includes(s)) {
        return punctuationDelayMs;
    }

    return defaultDelayMs;
}

/**
 * Parses the stream data and returns the parsed data and the chunk to be sent.
 * @param {object} json The JSON data.
 * @returns {AsyncGenerator<{data: object, chunk: string}>} The parsed data and the chunk to be sent.
 */
async function* parseStreamData(json) {
    // Cohere
    if (typeof json.delta === 'object' && typeof json.delta.message === 'object' && ['tool-plan-delta', 'content-delta'].includes(json.type)) {
        const text = json?.delta?.message?.content?.text ?? '';
        for (let i = 0; i < text.length; i++) {
            const str = json.delta.message.content.text[i];
            yield {
                data: { ...json, delta: { message: { content: { text: str } } } },
                chunk: str,
            };
        }
        return;
    }
    // Claude
    else if (typeof json.delta === 'object' && typeof json.delta.text === 'string') {
        if (json.delta.text.length > 0) {
            for (let i = 0; i < json.delta.text.length; i++) {
                const str = json.delta.text[i];
                yield {
                    data: { ...json, delta: { text: str } },
                    chunk: str,
                };
            }
        }
        return;
    }
    // MakerSuite
    else if (Array.isArray(json.candidates)) {
        for (let i = 0; i < json.candidates.length; i++) {
            const isNotPrimary = json.candidates?.[0]?.index > 0;
            const hasToolCalls = json?.candidates?.[0]?.content?.parts?.some(p => p?.functionCall);
            const hasInlineData = json?.candidates?.[0]?.content?.parts?.some(p => p?.inlineData);
            if (isNotPrimary || json.candidates.length === 0) {
                return null;
            }
            if (hasToolCalls || hasInlineData) {
                yield { data: json, chunk: '' };
                return;
            }
            if (typeof json.candidates[0].content === 'object' && Array.isArray(json.candidates[i].content.parts)) {
                for (let j = 0; j < json.candidates[i].content.parts.length; j++) {
                    if (typeof json.candidates[i].content.parts[j].text === 'string') {
                        for (let k = 0; k < json.candidates[i].content.parts[j].text.length; k++) {
                            const moreThanOnePart = json.candidates[i].content.parts.length > 1;
                            const isNotLastPart = j !== json.candidates[i].content.parts.length - 1;
                            const isLastSymbol = k === json.candidates[i].content.parts[j].text.length - 1;
                            const addNewline = moreThanOnePart && isNotLastPart && isLastSymbol;
                            const str = json.candidates[i].content.parts[j].text[k] + (addNewline ? '\n\n' : '');
                            const candidateClone = structuredClone(json.candidates[0]);
                            candidateClone.content.parts[j].text = str;
                            candidateClone.content.parts = [candidateClone.content.parts[j]];
                            const candidates = [candidateClone];
                            yield {
                                data: { ...json, candidates },
                                chunk: str,
                            };
                        }
                    }
                }
            }
        }
        return;
    }
    // NovelAI / KoboldCpp Classic
    else if (typeof json.token === 'string' && json.token.length > 0) {
        for (let i = 0; i < json.token.length; i++) {
            const str = json.token[i];
            yield {
                data: { ...json, token: str },
                chunk: str,
            };
        }
        return;
    }
    // llama.cpp?
    else if (typeof json.content === 'string' && json.content.length > 0 && json.object !== 'chat.completion.chunk') {
        for (let i = 0; i < json.content.length; i++) {
            const str = json.content[i];
            yield {
                data: { ...json, content: str },
                chunk: str,
            };
        }
        return;
    }
    // OpenAI-likes
    else if (Array.isArray(json.choices)) {
        const isNotPrimary = json?.choices?.[0]?.index > 0;
        if (isNotPrimary || json.choices.length === 0) {
            throw new Error('Not a primary swipe');
        }

        if (typeof json.choices[0].text === 'string' && json.choices[0].text.length > 0) {
            for (let j = 0; j < json.choices[0].text.length; j++) {
                const str = json.choices[0].text[j];
                const choiceClone = structuredClone(json.choices[0]);
                choiceClone.text = str;
                const choices = [choiceClone];
                yield {
                    data: { ...json, choices },
                    chunk: str,
                };
            }
            return;
        }
        else if (typeof json.choices[0].delta === 'object') {
            if (typeof json.choices[0].delta.text === 'string' && json.choices[0].delta.text.length > 0) {
                for (let j = 0; j < json.choices[0].delta.text.length; j++) {
                    const str = json.choices[0].delta.text[j];
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.delta.text = str;
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
                return;
            }
            else if (typeof json.choices[0].delta.reasoning_content === 'string' && json.choices[0].delta.reasoning_content.length > 0) {
                for (let j = 0; j < json.choices[0].delta.reasoning_content.length; j++) {
                    const str = json.choices[0].delta.reasoning_content[j];
                    const isLastSymbol = j === json.choices[0].delta.reasoning_content.length - 1;
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.delta.reasoning_content = str;
                    choiceClone.delta.content = isLastSymbol ? choiceClone.delta.content : '';
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
                return;
            }
            else if (typeof json.choices[0].delta.reasoning === 'string' && json.choices[0].delta.reasoning.length > 0) {
                for (let j = 0; j < json.choices[0].delta.reasoning.length; j++) {
                    const str = json.choices[0].delta.reasoning[j];
                    const isLastSymbol = j === json.choices[0].delta.reasoning.length - 1;
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.delta.reasoning = str;
                    choiceClone.delta.content = isLastSymbol ? choiceClone.delta.content : '';
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
                return;
            }
            else if (typeof json.choices[0].delta.content === 'string' && json.choices[0].delta.content.length > 0) {
                for (let j = 0; j < json.choices[0].delta.content.length; j++) {
                    const str = json.choices[0].delta.content[j];
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.delta.content = str;
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
                return;
            }
        }
        else if (typeof json.choices[0].message === 'object') {
            if (typeof json.choices[0].message.content === 'string' && json.choices[0].message.content.length > 0) {
                for (let j = 0; j < json.choices[0].message.content.length; j++) {
                    const str = json.choices[0].message.content[j];
                    const choiceClone = structuredClone(json.choices[0]);
                    choiceClone.message.content = str;
                    const choices = [choiceClone];
                    yield {
                        data: { ...json, choices },
                        chunk: str,
                    };
                }
                return;
            }
        }
    }

    throw new Error('Unknown event data format');
}

/**
 * Like the default one, but multiplies the events by the number of letters in the event data.
 */
export class SmoothEventSourceStream extends EventSourceStream {
    constructor() {
        super();
        let lastStr = ''; //used by getDelay to determine the delay based on the last character sent, not used in word-fade mode
        let bufferForWords = '';
        let lastWord = '';
        let previousParsed = null;
        let delayForNextRound = null;
        let weAreInACodeBlock = false;
        const speedFactor = Math.max(100 - power_user.smooth_streaming_speed, 1);
        const hasFocus = document.hasFocus();

        if (power_user.smooth_streaming_wordFade) {
            //make a stream transform that emits words with a trailing space
            const transformWordStream = new TransformStream({
                async transform(chunk, controller) {
                    const event = chunk;
                    const data = event.data;
                    try {
                        //const hasFocus = document.hasFocus();

                        //if we see stream done, reset lastStr
                        if (data === '[DONE]') {
                            //send out the remaining bits inside wordBuffer before ending the stream
                            if (bufferForWords.length > 0) {
                                lastWord = bufferForWords;
                                //console.info('[wordTransform] Emitting last buffered word:', lastWord);
                                hasFocus && await delay(delayForNextRound);
                                controller.enqueue(new MessageEvent(event.type, { data: JSON.stringify({ ...previousParsed.data, choices: [{ text: lastWord }] }) }));
                                bufferForWords = '';
                            }
                            return controller.enqueue(event);
                        }
                        //if we aren't done parse the data
                        const json = JSON.parse(data);
                        //if it's not json, just pass it through
                        if (!json) {
                            return controller.enqueue(event);
                        }

                        //here we have good data, let's look for full words with a trailing space, and emit the last word only
                        for await (const parsed of parseStreamData(json)) {

                            previousParsed = parsed; //save the last parsed good data in case we need to emit a final word on [DONE]
                            bufferForWords += parsed.chunk; //parsed.chunk = the latest letter to come through the stream

                            let bufferHasFullWord = bufferForWords.includes(' ');
                            //do a regex match to see if the buffer contains strings like `word`
                            let bufferHasFullCode = /`[^`]+`/.test(bufferForWords);
                            //do a regex match for ```(optional language word)\n
                            let bufferSawCodeFence = /```(.*)\n/.test(bufferForWords);

                            if (bufferSawCodeFence) {
                                weAreInACodeBlock = !weAreInACodeBlock;
                                //console.info('>>>We are now ' + (weAreInACodeBlock ? 'IN' : 'OUT OF') + ' a code block<<<');
                            }

                            if (!bufferHasFullWord && !bufferHasFullCode && !bufferSawCodeFence) {
                                //no full words yet, just wait for more data
                                continue;
                            }

                            if ((bufferHasFullWord || bufferHasFullCode || bufferSawCodeFence) && bufferForWords.length > 0) {
                                hasFocus && await delay(delayForNextRound);
                                //get the first word with a trailing space
                                //determine if words has newlines in it, if so split on newlines first

                                const lines = bufferForWords.split('\n');
                                //console.log('Lines in bufferForWords:', lines.length);
                                if (lines.length > 1) {
                                    //we have newlines, so the first word is the first word of the first line plus a newline
                                    const topLine = lines[0] + '\n';
                                    lastWord = topLine; //get the first word with a trailing newline
                                    //console.info(`bufferForWords: ${bufferForWords}, length: ${bufferForWords.length},lastWord: ${lastWord}, length: ${lastWord.length},`);
                                    bufferForWords = bufferForWords.substring(lastWord.length, bufferForWords.length);
                                    //console.info('Remaining buffer after topline cut:', bufferForWords);
                                } else {
                                    //no newlines, just split on spaces
                                    lastWord = bufferForWords.split(' ')[0] + ' '; //get the first word with a trailing space
                                    bufferForWords = bufferForWords.substring(lastWord.length, bufferForWords.length);
                                    //console.info('Remaining buffer after word cut:', bufferForWords);
                                }

                                //console.info('[wordTransform] Emitting word:', lastWord);

                                //send a controller event with the last word as the content
                                controller.enqueue(new MessageEvent(event.type, { data: JSON.stringify({ ...parsed.data, choices: [{ text: lastWord }] }) }));

                                function determineDelay() {
                                    if (lastWord.includes('.') || lastWord.includes('?') || lastWord.includes('!')) { return 10; } //sentence enders get a longer delay
                                    if (lastWord.includes(',')) { return 8; } //commas get a longer delay
                                    if (lastWord.trim().length <= 3) {
                                        return 1; //very short words get a very short delay
                                    } else if (lastWord.trim().length <= 6) {
                                        return 4; //short words get a short delay
                                    } else if (lastWord.trim().length <= 9) {
                                        return 6; //medium words get a medium delay
                                    } else {
                                        return 8; //long words get a longer delay
                                    }
                                }

                                delayForNextRound = weAreInACodeBlock ? 0 : (determineDelay() * speedFactor) + 50;
                            }
                        }
                    } catch (error) {
                        console.error('Smooth Streaming parsing error', error);
                        controller.enqueue(event);
                    }

                },

            });

            this.readable = this.readable.pipeThrough(transformWordStream);

        } else {
            const transformStream = new TransformStream({
                async transform(chunk, controller) {
                    const event = chunk;
                    const data = event.data;
                    try {
                        const hasFocus = document.hasFocus();

                        if (data === '[DONE]') {
                            lastStr = '';
                            return controller.enqueue(event);
                        }

                        const json = JSON.parse(data);

                        if (!json) {
                            lastStr = '';
                            return controller.enqueue(event);
                        }

                        for await (const parsed of parseStreamData(json)) {
                            hasFocus && await delay(getDelay(lastStr));
                            controller.enqueue(new MessageEvent(event.type, { data: JSON.stringify(parsed.data) }));
                            lastStr = parsed.chunk;
                        }
                    } catch (error) {
                        console.debug('Smooth Streaming parsing error', error);
                        controller.enqueue(event);
                    }
                },
            });
            this.readable = this.readable.pipeThrough(transformStream);
        }
    }
}

export function getEventSourceStream() {
    if (power_user.smooth_streaming) {
        return new SmoothEventSourceStream();
    }

    return new EventSourceStream();
}

export default EventSourceStream;
