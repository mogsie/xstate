// import { assert } from 'chai';
// import { Machine } from '../src/index';
import { machine, bigMachine } from './fixtures/proximity';
import { testAll } from './utils';
// import { mapValues } from '../src/utils';

describe('State proximity', () => {
  const expected = {
    A: {
      NEXT: 'A.bar'
    },
    'A.foo': {
      NEXT: 'A.bar'
    },
    'A.bar': {
      NEXT: 'B.foo'
    },
    'B.foo': {
      'NEXT,NEXT': 'A.foo'
    }
  };

  testAll(machine, expected);
});

describe('State proximity', () => {
  const expected = {
    A: {
      NEXT: 'B.two'
    },
    'A.one': {
      NEXT: 'B.two'
    },
    'B.two': {
      NEXT: 'B.foo.three'
    },
    'B.foo.three': {
      NEXT: 'B.four'
    }
  };

  testAll(bigMachine, expected);
});
