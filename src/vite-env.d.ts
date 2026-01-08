/// <reference types="vite/client" />

// Allow importing Python files as raw strings
declare module '*.py?raw' {
  const content: string;
  export default content;
}

// Allow importing text files as raw strings
declare module '*.txt?raw' {
  const content: string;
  export default content;
}
