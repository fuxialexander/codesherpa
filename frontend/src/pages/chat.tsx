import { useState, useEffect, useRef, MutableRefObject, useCallback } from 'react';
import { Model, pathMap, serverUrl, SYSTEM_PROMPT, SYSTEM_PROMPT_CODE_INTERPRETER } from '@/constants/openai';
import { operations } from '@/utils/services/plugin-protocol/codesherpa';
import { PaperAirplaneIcon } from '@heroicons/react/24/solid';
import ModelSelector from '@/components/model-selector';
import ChatMessage from '@/components/chat-message';
import { OpenAIError, descapeJsonString } from '@/utils/util';
import { Message } from '@/utils/services/openai/openai-stream';
import { toast } from 'react-toastify';
import "react-toastify/dist/ReactToastify.css";

export default function Chat() {
  const [selectedModel, setSelectedModel] = useState(Model.GPT3_5_CODE_INTERPRETER_16K);
  const [messages, setMessages] = useState<Message[]>([{ role: 'system', content: selectedModel === Model.GPT3_5_CODE_INTERPRETER_16K || Model.GPT4_CODE_INTERPRETER ? SYSTEM_PROMPT_CODE_INTERPRETER : SYSTEM_PROMPT }]);
  const [newMessage, setNewMessage] = useState('');
  const [isTyping, setIsTyping] = useState<boolean>(false);
  const [messageIsStreaming, setMessageIsStreaming] = useState(false);
  const [functionCallArgs, setFunctionCallArgs] = useState<string>('');
  const [conversationStarted, setConversationStarted] = useState(false);
  const [functionCall, setFunctionCall] = useState(null);
  const [isFunctionCall, setIsFunctionCall] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelStreamRef: MutableRefObject<boolean> = useRef(false);
  const accumulatedChunksRef: MutableRefObject<string> = useRef('');
  const [uploadedFileUrl, setUploadedFileUrl] = useState<string | null>(null);

  const isMobile = () => {
    const userAgent =
      typeof window.navigator === 'undefined' ? '' : navigator.userAgent;
    const mobileRegex =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i;
    return mobileRegex.test(userAgent);
  };

  const onUploadFile = async (event: any) => {
    const file = event.target.files[0];
    const formData = new FormData();
    formData.append('file', file);
    console.log('formData: ', formData);

    try {
      const response = await fetch('http://localhost:3333/upload', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (response.ok) {
        console.log('OK')
        // toast.success('File uploaded successfully');
        // Save the URL
        setUploadedFileUrl(data.url);
        console.log('data.url: ', data.url)
      } else {
        toast.error(`Upload failed: ${data.message}`);
      }
    } catch (error) {
      toast.error(`Upload failed: ${(error as Error).message}`);
    }
  };

  const fetchChat = async (messages: Message[], abortController: AbortController) => {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: abortController.signal,
      body: JSON.stringify({ messages, model: selectedModel }),
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder('utf-8');
    let assistantMessageContent = '';
    let isFunction = false;
    let first = true;
    let done = false;

    if (reader) {
      while (!done) {
        if (cancelStreamRef.current === true) {
          abortController.abort();
          done = true;
          break;
        }
        const { done: doneReading, value } = await reader.read();
        done = doneReading;
        if (done) {
          break;
        }
        let decodedValue = decoder.decode(value);
        assistantMessageContent += decodedValue;
        if (decodedValue.startsWith('{"function_call":')) {
          isFunction = true;
          setIsFunctionCall(true);
        }

        if (isFunction) {
          if (first) {
            first = false;
            const assistantMessage: Message = { role: 'assistant', name: 'function_call', content: decodedValue ?? '' };
            setMessages(prevMessages => [...prevMessages, assistantMessage]);

          } else {
            setMessages(prevMessages => {
              const updatedMessages = [...prevMessages];
              const lastMessage = updatedMessages[updatedMessages.length - 1];
              lastMessage.content = assistantMessageContent;
              return updatedMessages;
            });
          }
        } else {
          if (first) {
            first = false;
            const assistantMessage: Message = { role: 'assistant', content: decodedValue ?? '' };
            setMessages(prevMessages => [...prevMessages, assistantMessage]);

          } else {
            setMessages(prevMessages => {
              const updatedMessages = [...prevMessages];
              const lastMessage = updatedMessages[updatedMessages.length - 1];
              lastMessage.content = assistantMessageContent;
              return updatedMessages;
            });
          }
        }
      }
    }

    return assistantMessageContent;
  };

  const handleSendMessage = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setMessageIsStreaming(true);
      setConversationStarted(true);
      const newUserMessage: Message = { role: 'user', content: newMessage ?? '' };
      setNewMessage('');
      setMessages(prevMessages => [...prevMessages, newUserMessage]);

      const abortController = new AbortController();
      try {
        let assistantMessageContent = await fetchChat([...messages, newUserMessage], abortController);
        console.log('assistantMessageContent FIRST: ', assistantMessageContent);
        try {
          const parsed = JSON.parse(assistantMessageContent);
          let functionName = parsed.function_call.name;
          let functionArgumentsStr = parsed.function_call.arguments;

          // Descape and parse the arguments
          // let descapeArgumentsStr = descapeJsonString(functionArgumentsStr);
          // let functionArguments = JSON.parse(descapeArgumentsStr);
          setFunctionCall(parsed.function_call);
          console.log('function name: ', functionName);
          const requestBody = functionArgumentsStr;
          let endpoint = pathMap[functionName as keyof operations];
          if (!endpoint) {
            throw new Error('Endpoint is undefined');
          }
          console.log('endpoint: ', endpoint)
          const pluginResponse = await fetch(`${serverUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody
          });

          const parsedFunctionCallResponse = await pluginResponse.json();
          const stringifiedparsedFunctionCallResponse = JSON.stringify(parsedFunctionCallResponse);
          const pluginResponseMessage: Message = { role: 'assistant', name: 'function_call', content: stringifiedparsedFunctionCallResponse ?? '' };
          setMessages(prevMessages => [...prevMessages, pluginResponseMessage]);

          console.log('latest message: ', messages[messages.length]);


          const functionCallMessage: Message = { role: 'function', name: functionName, content: parsedFunctionCallResponse.result ?? '' };
          setMessages(prevMessages => [...prevMessages, functionCallMessage]);
          let secondAssistantMessageContent = await fetchChat([...messages, functionCallMessage], abortController);
          console.log('secondAssistantMessageContent INNER TRY: ', secondAssistantMessageContent);
        } catch (error) {
          // If parsing fails, continue accumulating chunks 
        }
      } catch (error) {
        if (error instanceof OpenAIError) {
          // Handle OpenAIError
          alert(`OpenAIError: ${error.message}`);
        } else if (error instanceof Error) {
          // Handle other errors
          alert(`Error: ${error.message}`);
        }
        setMessageIsStreaming(false);
        setIsFunctionCall(false);
        setNewMessage('');
      }
      setMessageIsStreaming(false);
      setIsFunctionCall(false);
      setNewMessage('');
    },
    [messages, newMessage, selectedModel, cancelStreamRef],
  );

  const stopConversationHandler = () => {
    setMessageIsStreaming(false);
    setNewMessage('');
    cancelStreamRef.current = true;
    setTimeout(() => {
      cancelStreamRef.current = false;
    }, 1000);
  };

  useEffect(() => {
    if (textareaRef.current) {
      // Reset the height to auto to reduce the height and recalculate scrollHeight
      textareaRef.current.style.height = 'inherit';

      // Set the height to scrollHeight to expand the textarea
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;

      // Set the maxHeight to limit how much the textarea can expand
      textareaRef.current.style.maxHeight = '400px';

      // Set the overflow to auto if the content exceeds maxHeight
      textareaRef.current.style.overflowY = textareaRef.current.scrollHeight > 400 ? 'auto' : 'hidden';
    }
  }, [newMessage]);

  const messageEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messageEndRef.current) {
      messageEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  return (
    <>
      <div className="relative h-screen mx-0">

        <div className="flex flex-col h-screen p-6 mx-14">
          <div className={`absolute top-0 left-0 w-full border-transparent  dark:border-white/20 dark:via-[#343541] dark:to-[#343541] 
      ${conversationStarted ? 'pt-0 md:pt-0' : 'pt-8 md:pt-6'}`}>
            <div className={`flex flex-row justify-center z-50 items-center pt-0 mx-0 md:mx-0 ${conversationStarted ? 'fixed' : ''}`}>
              <ModelSelector selectedModel={selectedModel} setSelectedModel={setSelectedModel} conversationStarted={conversationStarted} />
            </div>
            <div className="w-full mx-2 mt-4 flex flex-row gap-3 last:mb-2 md:mx-4 md:mt-[52px] md:last:mb-6 lg:mx-auto">
              <div className="flex-1 overflow-auto mt-12 mb-40 bg-transparent">
                {messages.map((message, index) => message.role !== 'system' && <ChatMessage key={index} message={message} isStreaming={messageIsStreaming} streamingMessageIndex={messages.length - 1} currentMessageIndex={index} isFunctionCall={isFunctionCall} selectedModel={selectedModel} />)}
                <div ref={messageEndRef} />
              </div>
            </div>
          </div>
          <div className="fixed border-0 bottom-0 left-0 w-full dark:border-orange-200 bg-gradient-to-b from-transparent via-white to-white pt-6 dark:via-[#1f232a] dark:to-[#1f232a] md:pt-2">
            <div className="stretch mt-4 flex flex-row gap-3 last:mb-2 md:mx-4 md:mt-[52px] md:last:mb-6 lg:mx-auto lg:max-w-3xl">
              <div className="relative mx-2 flex w-full flex-grow flex-col rounded-xl border-black/10 bg-slate-100 shadow-[0_0_10px_rgba(0,0,0,0.10)] dark:bg-gray-700 dark:text-white  dark:focus:border-12 dark:shadow-[0_0_20px_rgba(0,0,0,0.10)] sm:mx-4 outline-none">
                {/* Upload button. Upload files to http://localhost:3333/upload'*/}
                <input
                  type="file"
                  id="fileUpload"
                  style={{ display: 'none' }}
                  onChange={onUploadFile}
                />
                <button
                  className="absolute left-2 top-2 rounded-sm p-1 text-neutral-800 opacity-60 hover:bg-neutral-200 hover:text-neutral-900 dark:bg-opacity-50 dark:hover:bg-opacity-20 dark:text-neutral-100 dark:hover:text-neutral-100"
                  onClick={() => document.getElementById('fileUpload')?.click()}
                  onKeyDown={() => { }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                  </svg>
                </button>
                <textarea
                  ref={textareaRef}
                  className="outline-none my-0 mr-2 ml-2 w-full resize-none bg-slate-200 rounded-md p-0 py-2 pr-12 pl-10 text-black dark:bg-transparent dark:text-white md:py-3 md:pl-10 placeholder:text-gray-400 dark:placeholder:text-gray-300 min-h-14"
                  style={{
                    resize: 'none',
                    bottom: `${textareaRef?.current?.scrollHeight}px`,
                    maxHeight: '400px',
                    overflow: `${textareaRef.current && textareaRef.current.scrollHeight > 400
                      ? 'auto'
                      : 'hidden'
                      }`,
                  }}
                  placeholder={
                    `Send a message`
                  }
                  value={newMessage}
                  rows={1}
                  onCompositionStart={() => setIsTyping(true)}
                  onCompositionEnd={() => setIsTyping(false)}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isTyping && !isMobile() && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage(e);
                    }
                  }}
                />
                {messageIsStreaming ? (
                  <button
                    type="submit"
                    className={`absolute right-2 top-2 rounded-sm p-1 text-neutral-800 opacity-90 bg-red-500 dark:bg-opacity-50 dark:text-neutral-100 dark:hover:text-neutral-900 duration-100 transition-all`}
                    onClick={stopConversationHandler}
                  >
                    <span className="">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                        <path className="animate-pulse duration-150" strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
                      </svg>
                    </span>
                  </button>
                ) : (
                  <button
                    type="submit"
                    className={`${newMessage.length === 0 ? '-rotate-90 transform-gpu absolute bg-transparent rounded-3xl top-2 right-2 p-1 text-neutral-800 opacity-60  dark:text-neutral-100 cursor-not-allowed ease-in duration-200 transition-all' : 'rotate-0 transform-gpu bottom-2 mr-2 absolute right-2  rounded-sm p-1 text-neutral-100  bg-fuchsia-500  dark:text-neutral-100 dark:hover:text-neutral-200 ease-out duration-500 transition-all'}`}
                    onClick={handleSendMessage}
                    disabled={newMessage.length === 0}
                  >
                    <span className=''>
                      <PaperAirplaneIcon className={`${newMessage.length === 0 ? 'h-0 w-0' : 'h-6 w-6'}`} />
                    </span>
                  </button>
                )}
              </div>
            </div>
            <div className="px-3 pt-2 pb-3 text-center text-[12px] text-black/50 dark:text-white/50 md:px-4 md:pt-3 md:pb-6">            <a
              href="https://github.com/iamgreggarcia/codesherpa"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
            </a>
              {' '}

            </div>
          </div>
        </div>
      </div>
    </>
  );
}