export function createErrorArray() {
  let errorArray = [];

  return {
    addError: (error) => errorArray.push(error),
    getErrors: () => errorArray
  };
}
