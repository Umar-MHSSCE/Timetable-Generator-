let word1 = "abc"
let word2 = "pqr"

let mergedword = mergeAlternately(word1, word2)

var mergeAlternately = function(word1, word2) {
    let length
    if(word1.length <= word2.lemgth){
        length = word1.length
    }
    else{
        length = word2.length
    }

    let mergedstring
    for (let i = 0; i<=length ; i++){
        let merged = word1[i] + word2[i]
        mergedstring.append(merged)
    }

};