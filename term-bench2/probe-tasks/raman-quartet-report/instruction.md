You are given the output file of a Raman Setup. We used it to measure a defective graphene sample.

Find the D, G, D' and 2D bands of the spectrum and write their positions to a file called "/app/results.json".

The file should have the following format:
{
  "D":  { "x0": <x0_value> },
  "G":  { "x0": <x0_value> },
  "D'": { "x0": <x0_value> },
  "2D": { "x0": <x0_value> }
}
